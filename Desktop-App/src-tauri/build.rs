fn main() {
    let build_sha = std::env::var("MUSICDECK_BUILD_SHA")
        .or_else(|_| std::env::var("GITHUB_SHA"))
        .unwrap_or_default();
    println!("cargo:rustc-env=MUSICDECK_BUILD_SHA={build_sha}");
    println!("cargo:rerun-if-env-changed=MUSICDECK_BUILD_SHA");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    tauri_build::build()
}
