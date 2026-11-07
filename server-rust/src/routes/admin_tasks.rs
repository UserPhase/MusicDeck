//! # Admin Background Tasks & Schedules HTTP/SSE Routes (`routes::admin_tasks`)
//!
//! Ports `server/src/routes/admin/tasks.ts`:
//! - `GET /api/v1/admin/tasks`
//! - `DELETE /api/v1/admin/tasks/history`
//! - `GET /api/v1/admin/tasks/:task_id/logs`
//! - `POST /api/v1/admin/tasks`
//! - `POST /api/v1/admin/tasks/:task_id/pause`
//! - `POST /api/v1/admin/tasks/:task_id/resume`
//! - `POST /api/v1/admin/tasks/:task_id/cancel`
//! - `PATCH /api/v1/admin/tasks/:task_id/priority`
//! - `GET /api/v1/admin/tasks/schedules`
//! - `PUT /api/v1/admin/tasks/schedules`
//! - `DELETE /api/v1/admin/tasks/schedules/:type`
//! - `GET /api/v1/admin/tasks/events` & `GET /api/v1/admin/tasks/stream` (SSE)

use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{delete, get, patch, post};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_stream::StreamExt as _;
use tokio_stream::wrappers::BroadcastStream;

use crate::AppState;
use crate::auth::RequireAdmin;
use crate::error::ServerError;
use crate::tasks::{Task, TaskError, TaskEvent, TaskType};

fn map_task_error(err: TaskError) -> ServerError {
    match err {
        TaskError::NotFound => ServerError::NotFound(err.to_string()),
        TaskError::Validation(msg) => ServerError::BadRequest(msg),
        TaskError::Conflict(msg) => ServerError::Conflict(msg),
        TaskError::Cancelled => ServerError::Conflict(String::from("Cancelled")),
        TaskError::ExecutionFailed(msg) => ServerError::Internal(msg),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnqueueTaskBody {
    #[serde(rename = "type")]
    pub task_type: TaskType,
    #[serde(default)]
    pub payload: Option<Value>,
    #[serde(default)]
    pub priority: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchPriorityBody {
    pub priority: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutScheduleBody {
    #[serde(rename = "type")]
    pub task_type: TaskType,
    #[serde(default)]
    pub payload: Option<Value>,
    pub expression: String,
}

/// Builds the router for `/api/v1/admin/tasks/*`.
pub fn admin_tasks_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/admin/tasks",
            get(list_tasks_handler).post(enqueue_task_handler),
        )
        .route("/api/v1/admin/tasks/history", delete(clear_history_handler))
        .route(
            "/api/v1/admin/tasks/:task_id/logs",
            get(get_task_logs_handler),
        )
        .route(
            "/api/v1/admin/tasks/:task_id/pause",
            post(pause_task_handler),
        )
        .route(
            "/api/v1/admin/tasks/:task_id/resume",
            post(resume_task_handler),
        )
        .route(
            "/api/v1/admin/tasks/:task_id/cancel",
            post(cancel_task_handler),
        )
        .route(
            "/api/v1/admin/tasks/:task_id/priority",
            patch(reprioritize_task_handler),
        )
        .route(
            "/api/v1/admin/tasks/schedules",
            get(list_schedules_handler).put(put_schedule_handler),
        )
        .route(
            "/api/v1/admin/tasks/schedules/:type",
            delete(delete_schedule_handler),
        )
        .route("/api/v1/admin/tasks/events", get(stream_task_events_handler))
        .route("/api/v1/admin/tasks/stream", get(stream_task_events_handler))
}

async fn list_tasks_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Response, ServerError> {
    let limit = match params.get("limit") {
        Some(raw) => Some(
            raw.parse::<usize>()
                .ok()
                .filter(|&v| (1..=500).contains(&v))
                .ok_or_else(|| ServerError::BadRequest(String::from("Invalid task list options")))?,
        ),
        None => None,
    };

    let include_terminal = match params.get("includeTerminal").map(String::as_str) {
        Some("true") => true,
        Some("false") | None => false,
        Some(_) => {
            return Err(ServerError::BadRequest(String::from(
                "Invalid task list options",
            )))
        }
    };

    let tasks = state
        .tasks()
        .list(limit, include_terminal)
        .await
        .map_err(map_task_error)?;
    let public_tasks: Vec<Value> = tasks.iter().map(Task::to_public_json).collect();

    Ok((StatusCode::OK, Json(json!({ "tasks": public_tasks }))).into_response())
}

async fn clear_history_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Result<Response, ServerError> {
    let ids = state.tasks().clear_history().await;
    Ok((StatusCode::OK, Json(json!({ "ids": ids }))).into_response())
}

async fn get_task_logs_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(task_id): Path<String>,
) -> Result<Response, ServerError> {
    let entries = state
        .tasks()
        .diagnostics(&task_id)
        .await
        .map_err(map_task_error)?;
    Ok((StatusCode::OK, Json(json!({ "entries": entries }))).into_response())
}

async fn enqueue_task_handler(
    State(state): State<AppState>,
    admin: RequireAdmin,
    Json(body): Json<EnqueueTaskBody>,
) -> Result<Response, ServerError> {
    let task = state
        .tasks()
        .enqueue(
            body.task_type,
            body.payload.unwrap_or_else(|| json!({})),
            &admin.user.id,
            body.priority,
        )
        .await
        .map_err(map_task_error)?;

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({ "task": task.to_public_json() })),
    )
        .into_response())
}

async fn pause_task_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(task_id): Path<String>,
) -> Result<Response, ServerError> {
    let task = state.tasks().pause(&task_id).await.map_err(map_task_error)?;
    Ok((StatusCode::OK, Json(json!({ "task": task.to_public_json() }))).into_response())
}

async fn resume_task_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(task_id): Path<String>,
) -> Result<Response, ServerError> {
    let task = state
        .tasks()
        .resume(&task_id)
        .await
        .map_err(map_task_error)?;
    Ok((StatusCode::OK, Json(json!({ "task": task.to_public_json() }))).into_response())
}

async fn cancel_task_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(task_id): Path<String>,
) -> Result<Response, ServerError> {
    let task = state
        .tasks()
        .cancel(&task_id)
        .await
        .map_err(map_task_error)?;
    Ok((StatusCode::OK, Json(json!({ "task": task.to_public_json() }))).into_response())
}

async fn reprioritize_task_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(task_id): Path<String>,
    Json(body): Json<PatchPriorityBody>,
) -> Result<Response, ServerError> {
    let task = state
        .tasks()
        .reprioritize(&task_id, body.priority)
        .await
        .map_err(map_task_error)?;
    Ok((StatusCode::OK, Json(json!({ "task": task.to_public_json() }))).into_response())
}

async fn list_schedules_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Result<Response, ServerError> {
    let schedules = state.tasks().list_schedules().await;
    Ok((StatusCode::OK, Json(json!({ "schedules": schedules }))).into_response())
}

async fn put_schedule_handler(
    State(state): State<AppState>,
    admin: RequireAdmin,
    Json(body): Json<PutScheduleBody>,
) -> Result<Response, ServerError> {
    let schedule = state
        .tasks()
        .set_schedule(
            body.task_type,
            body.payload.unwrap_or_else(|| json!({})),
            &body.expression,
            &admin.user.id,
        )
        .await
        .map_err(map_task_error)?;

    Ok((StatusCode::CREATED, Json(json!({ "schedule": schedule }))).into_response())
}

async fn delete_schedule_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
    Path(type_raw): Path<String>,
) -> Result<Response, ServerError> {
    let Some(task_type) = TaskType::parse(&type_raw) else {
        return Err(ServerError::BadRequest(String::from("Unknown task type")));
    };
    state.tasks().remove_schedule(task_type).await.map_err(map_task_error)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn stream_task_events_handler(
    State(state): State<AppState>,
    _admin: RequireAdmin,
) -> Result<Response, ServerError> {
    let initial_tasks: Vec<Value> = state
        .tasks()
        .list(Some(100), true)
        .await
        .unwrap_or_default()
        .iter()
        .map(Task::to_public_json)
        .collect();
    let schedules = state.tasks().list_schedules().await;
    let metrics = state.tasks().metrics();

    let snapshot_event = Event::default()
        .event("tasks.snapshot")
        .data(
            json!({
                "tasks": initial_tasks,
                "schedules": schedules,
                "metrics": metrics,
            })
            .to_string(),
        );

    let rx = state.tasks().subscribe();
    let live_stream = BroadcastStream::new(rx).filter_map(|res| {
        let ev = res.ok()?;
        let sse = match ev {
            TaskEvent::State(task) => Event::default()
                .event("task.state")
                .data(json!({ "task": task.to_public_json() }).to_string()),
            TaskEvent::Progress(task) => Event::default()
                .event("task.progress")
                .data(json!({ "task": task.to_public_json() }).to_string()),
            TaskEvent::HistoryCleared(ids) => Event::default()
                .event("history.cleared")
                .data(json!({ "ids": ids }).to_string()),
        };
        Some(Ok::<Event, Infallible>(sse))
    });

    let combined = tokio_stream::once(Ok::<Event, Infallible>(snapshot_event)).chain(live_stream);

    Ok(Sse::new(combined)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(25)))
        .into_response())
}
