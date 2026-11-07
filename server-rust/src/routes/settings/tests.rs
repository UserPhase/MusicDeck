use super::*;
use axum::body::Body;
use http::{Method, Request};
use http_body_util::BodyExt;
use serde_json::json;
use std::time::Duration;
use tower::ServiceExt;

use crate::auth::SESSION_COOKIE;
use crate::db::run_migrations;
use crate::tasks::TaskType;
use crate::{AppConfig, create_router};

async fn fixture() -> (DbPool, AppState, String) {
    let db = DbPool::connect_memory().await.unwrap();
    run_migrations(&db, None).await.unwrap();
    sqlx::raw_sql(
        "INSERT INTO roles VALUES ('admin', 'Administrator');
        INSERT INTO users (id, username, password_hash, display_name, role, created_at, updated_at)
        VALUES ('admin', 'admin', 'unused', 'Admin', 'admin', '2026-01-01', '2026-01-01');",
    )
    .execute(db.inner())
    .await
    .unwrap();
    let mut config = AppConfig::default();
    config.database.database_path = ":memory:".into();
    let state = AppState::with_database(config, db.clone()).await.unwrap();
    state
        .tasks()
        .set_cron_tick_interval(Duration::from_secs(3600));
    let session = state
        .session_store()
        .unwrap()
        .create_session("admin", true)
        .await
        .unwrap();
    (db, state, format!("{SESSION_COOKIE}={}", session.id))
}

async fn send(state: &AppState, cookie: &str, method: Method, path: &str, body: Value) -> Response {
    tokio::time::timeout(
        Duration::from_secs(5),
        create_router(state.clone()).oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("cookie", cookie)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        ),
    )
    .await
    .expect("settings request should complete with one database connection")
    .unwrap()
}

async fn response_json(response: Response) -> Value {
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn settings_updates_read_back_on_a_single_connection_and_reschedule_the_worker() {
    let (db, state, cookie) = fixture().await;
    state.tasks().recover_interrupted_tasks().await;

    let user = send(
        &state,
        &cookie,
        Method::PATCH,
        "/api/settings/user",
        json!({"settings": {"ui.theme": "dark"}}),
    )
    .await;
    assert_eq!(
        response_json(user).await["settings"][0]["value"],
        "\"dark\""
    );

    let path = "/api/admin/settings/server";
    let response = send(
        &state,
        &cookie,
        Method::PATCH,
        path,
        json!({"settings": {"library.scanSchedule": "  *  * * * * "}}),
    )
    .await;
    assert_eq!(
        response_json(response).await["settings"][0]["value"],
        "\"* * * * *\""
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let tasks = state.tasks().list(Some(5), true).await.unwrap();
            if tasks
                .iter()
                .any(|task| task.task_type == TaskType::LibraryScan)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("a settings save should wake the cron worker");

    let response = send(
        &state,
        &cookie,
        Method::PATCH,
        path,
        json!({"settings": {"library.scanSchedule": "30 22 * * 5"}}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let schedules = state.tasks().list_schedules().await;
    assert_eq!(schedules.len(), 1);
    assert_eq!(schedules[0].expression, "30 22 * * 5");

    let status_path = "/api/admin/library/scan/status";
    let status = send(&state, &cookie, Method::GET, status_path, Value::Null).await;
    assert_eq!(
        response_json(status).await["status"]["expression"],
        "30 22 * * 5"
    );

    let response = send(
        &state,
        &cookie,
        Method::PATCH,
        path,
        json!({"settings": {"library.scanSchedule": "off"}}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(state.tasks().list_schedules().await.is_empty());
    let status = send(&state, &cookie, Method::GET, status_path, Value::Null).await;
    assert_eq!(response_json(status).await["status"]["enabled"], false);
    state.tasks().close();
    db.close().await;
}

#[tokio::test]
async fn failed_cron_write_rolls_back_settings_and_preserves_the_restored_schedule() {
    let (db, state, cookie) = fixture().await;
    sqlx::query("INSERT INTO server_settings VALUES ('library.scanSchedule', ?, '2026-01-01')")
        .bind("\"30 22 * * 5\"")
        .execute(db.inner())
        .await
        .unwrap();
    state.tasks().recover_interrupted_tasks().await;
    assert_eq!(
        state.tasks().list_schedules().await[0].expression,
        "30 22 * * 5"
    );

    sqlx::query(
        "CREATE TRIGGER reject_cron BEFORE UPDATE ON background_task_schedules
        BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    )
    .execute(db.inner())
    .await
    .unwrap();
    let response = send(
        &state,
        &cookie,
        Method::PATCH,
        "/api/admin/settings/server",
        json!({"settings": {"library.scanSchedule": "* * * * *", "jobs.maxConcurrency": 3}}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let settings = list_server_settings(&db).await.unwrap();
    assert_eq!(settings.len(), 1);
    assert_eq!(settings[0].value, "\"30 22 * * 5\"");
    assert_eq!(
        state.tasks().list_schedules().await[0].expression,
        "30 22 * * 5"
    );
    state.tasks().close();
    db.close().await;
}
