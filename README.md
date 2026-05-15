# SYNAPSE
> Deploy your app. Notify your team. Manage your infra. One sentence.

SYNAPSE is a natural language DevOps automation system. You describe what you want — it figures out which tools to use, chains them in order, and streams real-time output back to you.

---

## What it does

**Example 1 — Remote command**
```
You: check disk usage on the server and alert me on Telegram if it's above 80%
SYNAPSE: [RunShellCommand] df -h → 72% used. Below threshold. No alert sent.
```

**Example 2 — CI/CD pipeline**
```
You: trigger my deploy workflow on main and notify me when it's done
SYNAPSE: [GitHubActions trigger] run_id=12345 queued
         [GitHubActions status] completed → success (47s)
         [SendTelegramNotification] "Deploy succeeded in 47s"
```

**Example 3 — Docker + AWS**
```
You: build my Docker image, push to ECR, and deploy to EC2
SYNAPSE: [RunDockerCommand] build → sha256:abc
         [RunAWSCommand] ecr get-login-password → ok
         [RunDockerCommand] push → pushed
         [RunAWSCommand] ec2 run-instances → i-0abc123
```

---

## Architecture

SYNAPSE uses a 3-plane architecture:

| Plane | Technology | Role |
|---|---|---|
| Control | FastAPI + Socket.IO + LangGraph | Intent parsing, agent orchestration, streaming |
| Execution | Python adapters (Paramiko, boto3, httpx) | Runs real tools with typed I/O |
| UI | Vite + React + TypeScript | Streams output, shows active LLM provider |

The planes are independent — swap the LLM, add tools, or change the frontend without touching the others.

---

## Why model-agnostic?

A single LLM provider crashes when free-tier quotas run out. SYNAPSE's `ModelRouter` maintains a priority chain: **Groq → Gemini → Cerebras → Ollama**. When one provider hits a rate limit, the next takes over automatically. The UI shows which provider is active in real time.

Set `MODEL_BACKEND=auto` (default) to let the router decide, or force a specific provider: `MODEL_BACKEND=groq`.

---

## Tools (9 registered)

| Tool | Controls | Example command |
|---|---|---|
| RunShellCommand | Remote Linux (SSH) | "check memory usage on the server" |
| CreateRemoteFile | Remote file system | "create a nginx config at /etc/nginx/sites-enabled/app" |
| RunDockerCommand | Docker (remote SSH) | "show logs for the api container" |
| RunAWSCommand | AWS CLI (all services) | "list my S3 buckets" |
| GitHubActions | GitHub CI/CD | "trigger my deploy workflow and notify me when done" |
| TrainStartupModel | ML training (local) | "train the startup model" |
| SendEmailNotification | Email (Mailjet) | "email me the results" |
| SendSMSNotification | SMS (Twilio) | "text me when the deploy is done" |
| SendTelegramNotification | Telegram | "send a Telegram message when finished" |

---

## Quick start

```bash
# 1. Clone
git clone https://github.com/yourusername/synapse && cd synapse

# 2. Configure
cp .env.example .env
# Set at minimum: GROQ_API_KEY (free at console.groq.com)

# 3. Backend
python -m venv .venv && source .venv/Scripts/activate
pip install -r requirements.txt
python start_backend.py

# 4. Frontend
cd synapse && npm install && npm run dev

# 5. Open http://localhost:5173
```

---

## Adding a new tool

1. Define input/output models in `tool_schemas.py`
2. Implement the adapter class or function
3. Add a `Tool(...)` entry in `main.py`
4. Add a description — the agent uses this to decide when to call your tool
