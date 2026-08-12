use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State as AxState};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::SharedState;

const MAX_AGENTS: usize = 6;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstance {
    pub id: String,
    #[serde(rename = "type")]
    pub agent_type: String,
    pub name: String,
    pub status: String,
    pub cwd: String,
    pub workspace_id: Option<String>,
}

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
    state: SharedState,
}

#[tauri::command]
pub fn sync_agents(state: State<'_, SharedState>, agents: Vec<AgentInstance>) {
    *state.agents.lock() = agents;
}

#[tauri::command]
pub fn control_add_agent_result(state: State<'_, SharedState>, request_id: String, agent: AgentInstance) {
    if let Some(tx) = state.pending_adds.lock().remove(&request_id) {
        let _ = tx.send(agent);
    }
}

#[tauri::command]
pub fn get_control_port(state: State<'_, SharedState>) -> u16 {
    *state.control_port.lock()
}

async fn add_agent_via_frontend(ctx: &Ctx, agent_type: &str, task_hint: Option<&str>) -> Result<AgentInstance, String> {
    {
        let count = ctx.state.agents.lock().len();
        if count >= MAX_AGENTS {
            return Err(format!("agent cap reached ({})", MAX_AGENTS));
        }
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<AgentInstance>();
    ctx.state.pending_adds.lock().insert(request_id.clone(), tx);
    let _ = ctx.app.emit(
        "control-add-agent",
        serde_json::json!({ "requestId": request_id, "agentType": agent_type, "taskHint": task_hint }),
    );
    match tokio::time::timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(agent)) => Ok(agent),
        _ => {
            ctx.state.pending_adds.lock().remove(&request_id);
            Err("frontend did not create the agent in time".into())
        }
    }
}

async fn wait_for_ready(state: &SharedState, id: &str, timeout_secs: u64) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);
    let mut last_len = 0usize;
    let mut stable = 0u32;
    loop {
        if tokio::time::Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        let found = {
            let ptys = state.ptys.lock();
            ptys.get(id).map(|s| (s.buffer.len(), s.buffer.clone()))
        };
        let Some((len, text)) = found else { continue };
        if text.contains("? for shortcuts") || text.contains("shortcuts") && len > 400 {
            return;
        }
        if len > 300 && len == last_len {
            stable += 1;
            if stable >= 4 {
                return;
            }
        } else {
            stable = 0;
        }
        last_len = len;
    }
}

fn write_to_pty(state: &SharedState, id: &str, text: &str, submit: bool) -> bool {
    let input = {
        let ptys = state.ptys.lock();
        let Some(s) = ptys.get(id) else { return false };
        s.input.clone()
    };
    let clean = text.replace('\n', " ");
    let ok = input.send(clean.into_bytes()).is_ok();
    if ok && submit {
        std::thread::sleep(Duration::from_millis(150));
        let _ = input.send(b"\r".to_vec());
    }
    ok
}

async fn list_agents(AxState(ctx): AxState<Arc<Ctx>>) -> Json<serde_json::Value> {
    let agents = ctx.state.agents.lock().clone();
    Json(serde_json::json!({ "agents": agents }))
}

#[derive(Deserialize)]
struct AddBody {
    #[serde(rename = "type")]
    agent_type: Option<String>,
}

async fn add_agent(
    AxState(ctx): AxState<Arc<Ctx>>,
    body: Option<Json<AddBody>>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let agent_type = body
        .and_then(|b| b.0.agent_type)
        .unwrap_or_else(|| "claude".to_string());
    let agent = add_agent_via_frontend(&ctx, &agent_type, None)
        .await
        .map_err(|e| (StatusCode::TOO_MANY_REQUESTS, e))?;
    wait_for_ready(&ctx.state, &agent.id, 45).await;
    Ok(Json(serde_json::json!({ "agent": agent })))
}

#[derive(Deserialize)]
struct InputBody {
    text: String,
    submit: Option<bool>,
}

async fn agent_input(
    AxState(ctx): AxState<Arc<Ctx>>,
    Path(id): Path<String>,
    Json(body): Json<InputBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let ok = write_to_pty(&ctx.state, &id, &body.text, body.submit.unwrap_or(true));
    if ok {
        Ok(Json(serde_json::json!({ "ok": true })))
    } else {
        Err((StatusCode::NOT_FOUND, format!("no agent {}", id)))
    }
}

#[derive(Deserialize)]
struct OutputQuery {
    tail: Option<usize>,
    raw: Option<u8>,
}

async fn agent_output(
    AxState(ctx): AxState<Arc<Ctx>>,
    Path(id): Path<String>,
    Query(q): Query<OutputQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let (buffer_exists, text) = {
        let ptys = ctx.state.ptys.lock();
        match ptys.get(&id) {
            Some(s) => (true, s.buffer.clone()),
            None => (false, String::new()),
        }
    };
    if !buffer_exists {
        return Err((StatusCode::NOT_FOUND, format!("no agent {}", id)));
    }
    let text = if q.raw.unwrap_or(0) == 1 { text } else { crate::pty::clean_output(&text) };
    let tail = q.tail.unwrap_or(4000);
    let out = if text.len() > tail {
        let start = text.len() - tail;
        let mut idx = start;
        while idx < text.len() && !text.is_char_boundary(idx) {
            idx += 1;
        }
        text[idx..].to_string()
    } else {
        text
    };
    Ok(Json(serde_json::json!({ "output": out })))
}

async fn remove_agent(AxState(ctx): AxState<Arc<Ctx>>, Path(id): Path<String>) -> Json<serde_json::Value> {
    let _ = ctx.app.emit("control-remove-agent", serde_json::json!({ "id": id }));
    Json(serde_json::json!({ "ok": true }))
}

#[derive(Deserialize)]
struct OrchestrateBody {
    goal: Option<String>,
    tasks: Vec<String>,
    #[serde(rename = "type")]
    agent_type: Option<String>,
}

async fn orchestrate(
    AxState(ctx): AxState<Arc<Ctx>>,
    Json(body): Json<OrchestrateBody>,
) -> Json<serde_json::Value> {
    let agent_type = body.agent_type.unwrap_or_else(|| "claude".to_string());
    let goal = body.goal.unwrap_or_default();
    let mut spawned: Vec<AgentInstance> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();

    for task in &body.tasks {
        match add_agent_via_frontend(&ctx, &agent_type, Some(task)).await {
            Ok(agent) => spawned.push(agent),
            Err(_) => dropped.push(task.clone()),
        }
    }

    let team: Vec<String> = spawned.iter().map(|a| a.name.clone()).collect();
    let mut waits = Vec::new();
    for (i, agent) in spawned.iter().enumerate() {
        let state = ctx.state.clone();
        let id = agent.id.clone();
        let name = agent.name.clone();
        let task = body.tasks.get(i).cloned().unwrap_or_default();
        let goal = goal.clone();
        let team = team.clone();
        let n = spawned.len();
        waits.push(tokio::spawn(async move {
            wait_for_ready(&state, &id, 60).await;
            let context = if goal.is_empty() {
                format!("You are {}, agent {} of {}. Teammates: {}. Your task: {}", name, i + 1, n, team.join(", "), task)
            } else {
                format!(
                    "You are {}, agent {} of {} working toward: {}. Teammates: {}. Your task: {}",
                    name, i + 1, n, goal, team.join(", "), task
                )
            };
            write_to_pty(&state, &id, &context, true);
        }));
    }
    for w in waits {
        let _ = w.await;
    }

    Json(serde_json::json!({ "agents": spawned, "dropped": dropped }))
}

pub async fn start_control_server(app: AppHandle, state: SharedState) {
    let ctx = Arc::new(Ctx { app, state: state.clone() });
    let router = Router::new()
        .route("/agents", get(list_agents).post(add_agent))
        .route("/agents/{id}/input", post(agent_input))
        .route("/agents/{id}/output", get(agent_output))
        .route("/agents/{id}", delete(remove_agent))
        .route("/orchestrate", post(orchestrate))
        .with_state(ctx);

    let base: u16 = std::env::var("AGENT_LAUNCHER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4575);

    for port in base..base + 10 {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                *state.control_port.lock() = port;
                println!("[control] Agent Launcher control API on http://127.0.0.1:{}", port);
                if let Err(e) = axum::serve(listener, router).await {
                    eprintln!("[control] server error: {}", e);
                }
                return;
            }
            Err(_) => continue,
        }
    }
    eprintln!("[control] could not bind any port {}..{}", base, base + 9);
}
