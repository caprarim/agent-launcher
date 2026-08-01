use serde_json::{json, Value};
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Request, Response, Server};

use crate::ptys::strip_ansi;
use crate::AgentInstance;

// Localhost-only HTTP control server so external processes (e.g. a Claude Code
// agent running inside one of the terminals) can drive the launcher: list, add,
// task and close agent terminals without any screen-coordinate clicking.

const VALID_TYPES: [&str; 5] = ["claude", "codex", "gemini", "cursor", "grok"];

// Hard cap on simultaneously running agents (user requirement).
const MAX_AGENTS: usize = 5;

// Signals that an agent CLI has finished booting and is waiting for input.
// Claude prints the prompt box (box-drawing chars) and a "? for shortcuts" hint.
const READY_MARKERS: [&str; 6] = [
    "for shortcuts",
    "Welcome to Claude",
    "Bypassing Permissions",
    "╭",
    "│ >",
    "esc to interrupt",
];

fn json_response(status: u16, body: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let payload = serde_json::to_string_pretty(body).unwrap_or_else(|_| "{}".into());
    let mut response = Response::from_string(payload).with_status_code(status);
    for (name, value) in [
        ("Content-Type", "application/json"),
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS"),
        ("Access-Control-Allow-Headers", "Content-Type"),
    ] {
        if let Ok(header) = Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            response.add_header(header);
        }
    }
    response
}

fn read_body(request: &mut Request) -> Value {
    let mut body = String::new();
    if request.as_reader().read_to_string(&mut body).is_err() {
        return json!({});
    }
    if body.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(&body).unwrap_or_else(|_| json!({}))
}

fn split_path(url: &str) -> (Vec<String>, Vec<(String, String)>) {
    let (path, query) = match url.split_once('?') {
        Some((p, q)) => (p, q),
        None => (url, ""),
    };
    let parts = path
        .split('/')
        .filter(|p| !p.is_empty())
        .map(|p| percent_decode(p))
        .collect();
    let params = query
        .split('&')
        .filter(|p| !p.is_empty())
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=')?;
            Some((percent_decode(k), percent_decode(v)))
        })
        .collect();
    (parts, params)
}

// Agent ids are `<type>-<timestamp>`, so full percent-decoding is overkill —
// but a hand-written URL can still carry escapes, and decoding them keeps the
// id lookup honest.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() && bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit()
        {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Ask the renderer to add an agent; resolves once its PTY is live.
fn add_agent(app: &AppHandle, agent_type: &str) -> Result<AgentInstance, String> {
    let state = crate::state(app);
    let request_id = format!(
        "add-{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
        state.next_add_counter()
    );

    let (tx, rx) = channel::<AgentInstance>();
    state
        .pending_adds
        .lock()
        .unwrap()
        .insert(request_id.clone(), tx);

    app.emit(
        "control:add-agent",
        json!({ "requestId": request_id, "type": agent_type }),
    )
    .map_err(|e| format!("App window is not open: {e}"))?;

    let agent = match rx.recv_timeout(Duration::from_secs(15)) {
        Ok(agent) => agent,
        Err(_) => {
            state.pending_adds.lock().unwrap().remove(&request_id);
            return Err("Timed out waiting for the app to create the agent".into());
        }
    };

    // The agent exists in the UI before its PTY does; callers immediately write
    // a prompt into it, so wait for the terminal to actually be there.
    let deadline = Instant::now() + Duration::from_secs(8);
    while !state.ptys.has(&agent.id) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(agent)
}

fn remove_agent(app: &AppHandle, id: &str) -> bool {
    let state = crate::state(app);
    let known = state.agents.lock().unwrap().iter().any(|a| a.id == id);
    if !known {
        return false;
    }
    let _ = app.emit("control:remove-agent", json!({ "id": id }));
    state.ptys.kill(id);
    state.ptys.drop_buffer(id);
    true
}

// Label an agent's tab from a prompt that arrived over the control API rather
// than the keyboard. Writing straight to the PTY bypasses the renderer's
// keystroke namer entirely, so every agent spawned and tasked by an
// orchestrating agent would otherwise keep its "claude-agent-3" placeholder
// forever. The renderer owns the naming rules, so ask it to do the work.
fn name_agent(app: &AppHandle, id: &str, prompt: &str) {
    let _ = app.emit("control:name-agent", json!({ "id": id, "text": prompt }));
}

// Wait until an agent's terminal looks ready for input, WITHOUT a blind fixed
// sleep: poll its captured output and return as soon as either a known "ready"
// marker shows up, or output has settled (CLI printed its UI then went quiet).
fn wait_until_ready(app: &AppHandle, id: &str) -> &'static str {
    let state = crate::state(app);
    let min = Duration::from_millis(1000);
    let settle = Duration::from_millis(650);
    let max = Duration::from_millis(15_000);
    let start = Instant::now();
    let mut last_len = usize::MAX;
    let mut last_change = Instant::now();

    while start.elapsed() < max {
        let out = strip_ansi(&state.ptys.read_output(id, Some(8000)));
        if out.len() != last_len {
            last_len = out.len();
            last_change = Instant::now();
        }
        if start.elapsed() >= min && !out.is_empty() {
            if READY_MARKERS.iter().any(|m| out.contains(m)) {
                return "marker";
            }
            if last_change.elapsed() >= settle {
                return "settled";
            }
        }
        std::thread::sleep(Duration::from_millis(110));
    }
    "timeout"
}

fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

// Build a single-line prompt (no embedded newlines — a raw PTY treats each
// newline as a separate Enter/submit) that gives one agent its task plus the
// shared context of what the whole team is doing.
fn build_team_prompt(goal: &str, tasks: &[String], index: usize) -> String {
    let n = tasks.len();
    let roster = tasks
        .iter()
        .enumerate()
        .map(|(i, t)| {
            format!(
                "Agent {}{}: {}",
                i + 1,
                if i == index { " (you)" } else { "" },
                truncate_chars(&collapse_whitespace(t), 120)
            )
        })
        .collect::<Vec<_>>()
        .join(" | ");
    let mine = collapse_whitespace(&tasks[index]);
    format!(
        "[Team build] Shared goal: {}. You are Agent {} of {}. Team split -> {}. \
         YOUR TASK (Agent {}): {}. Only create/modify files needed for your task so you don't \
         collide with the other agents; assume they are doing their parts in parallel. Start now.",
        collapse_whitespace(goal),
        index + 1,
        n,
        roster,
        index + 1,
        mine
    )
}

fn handle(app: &AppHandle, request: &mut Request) -> (u16, Value) {
    let method = request.method().as_str().to_uppercase();
    let (parts, params) = split_path(request.url());
    let state = crate::state(app);

    if method == "OPTIONS" {
        return (204, json!({}));
    }

    // GET / → help / health
    if method == "GET" && parts.is_empty() {
        return (
            200,
            json!({
                "name": "Agent Launcher Control API",
                "endpoints": {
                    "GET /agents": "List all agent terminals",
                    "POST /agents": "Add an agent. Body: { \"type\": \"claude\" | \"codex\" | \"gemini\" | \"cursor\" | \"grok\" }",
                    "POST /orchestrate": "Spawn a team in one call (fast). Body: { \"goal\": \"...\", \"tasks\": [\"...\",\"...\"], \"type\": \"claude\" }",
                    "POST /agents/:id/input": "Type into a terminal. Body: { \"text\": \"...\", \"submit\": true }",
                    "GET /agents/:id/output": "Read recent terminal output. Query: ?tail=4000&raw=1",
                    "DELETE /agents/:id": "Close a terminal",
                },
            }),
        );
    }

    // GET /agents → list
    if method == "GET" && parts.len() == 1 && parts[0] == "agents" {
        let agents = state.agents.lock().unwrap().clone();
        return (200, json!({ "agents": agents }));
    }

    // POST /agents → add
    if method == "POST" && parts.len() == 1 && parts[0] == "agents" {
        let body = read_body(request);
        let agent_type = body
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("claude")
            .to_lowercase();
        if !VALID_TYPES.contains(&agent_type.as_str()) {
            return (
                400,
                json!({ "error": format!("Invalid type \"{agent_type}\". Use one of: {}", VALID_TYPES.join(", ")) }),
            );
        }
        if state.agents.lock().unwrap().len() >= MAX_AGENTS {
            return (
                409,
                json!({ "error": format!("Agent limit reached ({MAX_AGENTS} max). Close one first.") }),
            );
        }
        return match add_agent(app, &agent_type) {
            Ok(agent) => (201, json!({ "agent": agent })),
            Err(e) => (500, json!({ "error": e })),
        };
    }

    // POST /orchestrate → spawn a whole team, wait for readiness in parallel,
    // and inject each agent's task + shared cross-agent context in ONE call.
    if method == "POST" && parts.len() == 1 && parts[0] == "orchestrate" {
        let body = read_body(request);
        let goal = body
            .get("goal")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let tasks: Vec<String> = body
            .get("tasks")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.as_str())
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let agent_type = body
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("claude")
            .to_lowercase();

        if !VALID_TYPES.contains(&agent_type.as_str()) {
            return (
                400,
                json!({ "error": format!("Invalid type \"{agent_type}\". Use one of: {}", VALID_TYPES.join(", ")) }),
            );
        }
        if goal.is_empty() {
            return (
                400,
                json!({ "error": "Missing \"goal\" (the shared objective the team is building)." }),
            );
        }
        if tasks.is_empty() {
            return (
                400,
                json!({ "error": "Missing \"tasks\": provide an array of per-agent task strings." }),
            );
        }

        let existing = state.agents.lock().unwrap().len();
        if existing >= MAX_AGENTS {
            return (
                409,
                json!({ "error": format!("Agent limit reached ({MAX_AGENTS} max, {existing} running). Close some first.") }),
            );
        }
        let slots = MAX_AGENTS - existing;
        let assigned: Vec<String> = tasks.iter().take(slots).cloned().collect();
        let dropped: Vec<String> = tasks.iter().skip(slots).cloned().collect();

        // 1) Spawn every agent in parallel.
        let spawns: Vec<_> = assigned
            .iter()
            .map(|_| {
                let app = app.clone();
                let agent_type = agent_type.clone();
                std::thread::spawn(move || add_agent(&app, &agent_type))
            })
            .collect();
        let mut agents: Vec<AgentInstance> = Vec::new();
        for handle in spawns {
            match handle.join() {
                Ok(Ok(agent)) => agents.push(agent),
                Ok(Err(e)) => return (500, json!({ "error": e })),
                Err(_) => return (500, json!({ "error": "Agent spawn thread panicked" })),
            }
        }

        // 2) Wait for them all to finish booting — in parallel, not 6s each.
        let readiness: Vec<&'static str> = {
            let waits: Vec<_> = agents
                .iter()
                .map(|a| {
                    let app = app.clone();
                    let id = a.id.clone();
                    std::thread::spawn(move || wait_until_ready(&app, &id))
                })
                .collect();
            waits
                .into_iter()
                .map(|h| h.join().unwrap_or("timeout"))
                .collect()
        };

        // 3) Send each agent its task + the shared team context.
        let results: Vec<Value> = agents
            .iter()
            .enumerate()
            .map(|(i, a)| {
                let prompt = build_team_prompt(&goal, &assigned, i);
                let ok = state.ptys.write(&a.id, &format!("{prompt}\r"));
                // Label the tab from this agent's own task, not from the team
                // prompt — that carries every sibling's task, so labelling from
                // it would name all five tabs the same thing.
                if ok {
                    name_agent(app, &a.id, &assigned[i]);
                }
                json!({
                    "agent": a.id,
                    "name": a.name,
                    "index": i + 1,
                    "ready": readiness[i],
                    "taskSent": ok,
                    "task": assigned[i],
                })
            })
            .collect();

        let mut payload = json!({
            "goal": goal,
            "spawned": agents.len(),
            "agents": results,
        });
        if !dropped.is_empty() {
            payload["dropped"] = json!(dropped);
            payload["note"] = json!(format!(
                "{} task(s) not assigned — would exceed the {MAX_AGENTS}-agent limit.",
                dropped.len()
            ));
        }
        return (201, payload);
    }

    // /agents/:id/...
    if parts.len() >= 2 && parts[0] == "agents" {
        let id = parts[1].clone();
        let sub = parts.get(2).map(|s| s.as_str());

        // DELETE /agents/:id
        if method == "DELETE" && sub.is_none() {
            let ok = remove_agent(app, &id);
            return if ok {
                (200, json!({ "ok": true }))
            } else {
                (404, json!({ "error": format!("No agent \"{id}\"") }))
            };
        }

        // POST /agents/:id/input
        if method == "POST" && sub == Some("input") {
            let body = read_body(request);
            let text = body
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            // submit defaults to true: append a carriage return to send the line
            let submit = body.get("submit").and_then(|v| v.as_bool()).unwrap_or(true);
            let payload = if submit {
                format!("{text}\r")
            } else {
                text.clone()
            };
            if !state.ptys.write(&id, &payload) {
                return (
                    404,
                    json!({ "error": format!("No live terminal \"{id}\" (it may still be starting)") }),
                );
            }
            // Only a submitted line is a real prompt; partial typing is half a
            // thought and would label the tab from a fragment.
            if submit {
                name_agent(app, &id, &text);
            }
            return (
                200,
                json!({ "ok": true, "sent": text.chars().count(), "submitted": submit }),
            );
        }

        // GET /agents/:id/output
        if method == "GET" && sub == Some("output") {
            let raw = params
                .iter()
                .any(|(k, v)| k.as_str() == "raw" && v.as_str() == "1");
            let tail = params
                .iter()
                .find(|(k, _)| k.as_str() == "tail")
                .and_then(|(_, v)| v.parse::<usize>().ok());
            let known = state.agents.lock().unwrap().iter().any(|a| a.id == id);
            if !known && !state.ptys.has_buffer(&id) {
                return (404, json!({ "error": format!("No agent \"{id}\"") }));
            }
            let out = state.ptys.read_output(&id, tail);
            let out = if raw { out } else { strip_ansi(&out) };
            return (200, json!({ "id": id, "output": out }));
        }
    }

    (404, json!({ "error": "Not found" }))
}

/// Bind the control API to loopback and serve it on a background thread.
/// Returns the port it actually bound to.
///
/// A busy port usually means another launcher instance owns it (several run
/// side by side), so walk to the next port instead of dying silently — a
/// permanent silent failure here makes the whole control API look "down".
pub fn start(app: AppHandle, base_port: u16) -> Option<u16> {
    let mut port = base_port;
    let mut attempts = 0;
    let server = loop {
        match Server::http(("127.0.0.1", port)) {
            Ok(server) => break server,
            Err(e) => {
                if attempts >= 20 {
                    eprintln!("[control] could not bind a control port: {e}");
                    return None;
                }
                eprintln!("[control] port {port} in use, trying {}...", port + 1);
                attempts += 1;
                port += 1;
            }
        }
    };

    println!("[control] Agent Launcher control API on http://127.0.0.1:{port}");

    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let app = app.clone();
            // One thread per request: /orchestrate blocks for seconds while a
            // whole team boots, and it must not stall the accept loop.
            std::thread::spawn(move || {
                let (status, body) = handle(&app, &mut request);
                let _ = request.respond(json_response(status, &body));
            });
        }
    });

    Some(port)
}
