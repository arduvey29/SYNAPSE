<div align="center">

# ⚡ SYNAPSE

### **S**ystemic **N**exus of **A**daptive **P**rocessing & **S**elf-**E**xecution

**Control your entire infrastructure with plain English.**

![Python](https://img.shields.io/badge/Python-3.13-3776AB?style=flat-square&logo=python)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?style=flat-square&logo=fastapi)
![LangGraph](https://img.shields.io/badge/LangGraph-ReAct-FF6B35?style=flat-square)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat-square&logo=typescript)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4.8-010101?style=flat-square&logo=socket.io)
![TailwindCSS](https://img.shields.io/badge/Tailwind-4.1-06B6D4?style=flat-square&logo=tailwindcss)

</div>

---

## What It Does

SYNAPSE is a personal infrastructure automation agent. You type what you want in plain English, and it figures out the right tools, sequences them, handles failures, and sends you a notification when done.

**Without SYNAPSE:** open a terminal, SSH into your server, remember the exact docker command, copy the container ID, curl the endpoint, manually text yourself the result.

**With SYNAPSE:** *"build the Flask image on the RHEL server, run it on port 5000, curl the health check, and SMS me the response."*

It breaks that sentence into a plan, executes each step with real tools, retries failures automatically, and replans if something goes wrong.

---

## Infrastructure It Controls

| Tool | What It Reaches |
|------|----------------|
| `RunShellCommand` | Remote RHEL/Linux server via SSH |
| `CreateRemoteFile` | Write files directly on the remote server |
| `RunDockerCommand` | Docker Desktop on your local Windows machine |
| `RunKubectlCommand` | Kubernetes (kubectl) on your local machine |
| `RunPowerShellCommand` | Local Windows PowerShell — files, disks, processes |
| `RunAWSCommand` | Any AWS CLI command (EC2, S3, RDS, Lambda…) |
| `TrainStartupModel` | Local ML training on CSV datasets |
| `SendEmailNotification` | Email via Mailjet |
| `SendSMSNotification` | SMS via Twilio |
| `SendTelegramNotification` | Telegram bot message |
| `GitHubActions` | Trigger workflows, check run status |

---

## Sample Commands

```
# Simple queries — answered instantly
how many files are in my D drive?
list all running docker containers
what kubernetes pods are in the default namespace?
show my AWS S3 buckets

# Multi-step automation — generates a live plan panel
build a docker image called myapp from the Dockerfile, run it on port 5000,
curl the /health endpoint, and SMS me the result

create a centos container, install flask inside it, write a hello world app,
expose port 8080, and send me a telegram with the container ID once it's running

deploy my app to kubernetes using deploy.yml, wait for the pods to be ready,
then email me the external IP address

spin up an EC2 t2.micro instance, install Python 3.11 on it, and email me the public IP
```

---

## How It Works

### Single-step path
Short, direct queries go straight to a ReAct agent. The LLM picks the right tool, calls it, and returns the result.

### Multi-step path (Planner + Executor)
For compound commands, a **Planner** first calls the LLM to produce a structured JSON plan — a sequence of numbered steps, each specifying which tool to use and its success criteria. The plan appears in the left panel of the UI in real time.

An **Executor** then runs each step one at a time:
1. Calls the intended tool via a fresh ReAct sub-agent
2. Verifies that the intended tool actually ran and that tool JSON did not report `success: false`
3. On failure → retries once automatically
4. On second failure → calls the Planner again to produce a revised plan, skipping steps already completed
5. Caps replanning at 2 times per session to avoid infinite loops

```
User message
    │
    ▼
needs_planning()?
    │ yes                    │ no
    ▼                        ▼
Planner.plan()          Single ReAct call
    │                        │
    ▼                        │
Executor.run_plan()          │
  ├─ step 1 → tool call      │
  ├─ step 2 → tool call      │
  │   └─ fail → retry        │
  │       └─ fail → replan   │
  └─ step N                  │
    │                        │
    ▼                        ▼
compose_final_answer() → command_output → UI
```

### Model Router
SYNAPSE doesn't depend on a single LLM provider. It tries them in order and automatically falls back if one is rate-limited or down:

```
Ollama slot 1 → Groq → Gemini → Cerebras → Ollama slot 2
```

Set `MODEL_BACKEND` to `groq`, `gemini`, `cerebras`, or `ollama` to prefer a provider while still keeping the remaining configured providers as fallbacks.

### Safety Gates

SYNAPSE can execute powerful local, remote, cloud, and Kubernetes commands. The tool layer blocks obviously destructive commands such as recursive deletes, format operations, Docker prune/rm, `kubectl delete`, and AWS delete/terminate calls unless the agent prefixes the command with `CONFIRMED:` after explicit user confirmation. SSH rejects unknown host keys by default unless `SSH_ALLOW_UNKNOWN_HOSTS=true` is set for a personal lab environment.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        BROWSER                               │
│   ┌──────────────────────────────────────────────────────┐  │
│   │  React + TypeScript + Tailwind CSS                    │  │
│   │  ┌─────────────────┐  ┌──────────────────────────┐   │  │
│   │  │   PlanPanel      │  │       ChatDisplay         │   │  │
│   │  │  (live steps +  │  │  (messages + typing      │   │  │
│   │  │   status icons) │  │   indicator)              │   │  │
│   │  └─────────────────┘  └──────────────────────────┘   │  │
│   │              Socket.IO client (ws://localhost:8000)   │  │
│   └──────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │ WebSocket
┌──────────────────────────▼──────────────────────────────────┐
│                     PYTHON BACKEND                           │
│   FastAPI + python-socketio (ASGI)                           │
│                                                              │
│   execute_natural_command event                              │
│       │                                                      │
│       ├─ needs_planning? ──yes──► Planner (LLM call)         │
│       │                              │                       │
│       │                          Executor                    │
│       │                              │                       │
│       └─────────────────────────────┤                       │
│                                     │                       │
│   ┌─────────────────────────────────▼──────────────────┐   │
│   │            LangGraph ReAct Agent                    │   │
│   │   (create_react_agent + astream_events v2)          │   │
│   └─────────────────────────────────┬──────────────────┘   │
│                                     │                       │
│   ┌─────────────────────────────────▼──────────────────┐   │
│   │                  Model Router                        │   │
│   │ Ollama slot 1 → Groq → Gemini → Cerebras → Ollama 2 │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                              │
│   Tools                                                      │
│   ├─ LinuxAgent          (paramiko SSH → RHEL server)        │
│   ├─ LocalDockerAgent    (subprocess → Docker Desktop)       │
│   ├─ LocalKubectlAgent   (subprocess → kubectl)              │
│   ├─ LocalPowerShellAgent(subprocess → PowerShell)           │
│   ├─ AWSAgent            (subprocess → aws cli)              │
│   ├─ NotificationAgent   (email / SMS / Telegram)            │
│   ├─ TrainingAgent       (scikit-learn local)                │
│   └─ GitHubActions       (GitHub REST API)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
final-project/
├── main.py                  # FastAPI + Socket.IO server, tool registry, event handlers
├── agent_prompts.py         # System prompt for the ReAct agent
├── planner.py               # Planner: LLM → JSON plan → Plan object
├── executor.py              # Executor: step-by-step with retry + replan
├── orchestration.py         # needs_planning() heuristic + compose_final_answer()
├── model_router.py          # LLM provider fallback chain
├── agent_memory.py          # In-session memory store
│
├── linux_agent.py           # SSH tool (paramiko)
├── docker_agent.py          # Local Docker subprocess tool
├── kubectl_agent.py         # Local kubectl subprocess tool
├── powershell_agent.py      # Local PowerShell subprocess tool
├── aws_agent.py             # AWS CLI subprocess tool
├── notification_agent.py    # Email / SMS / Telegram
├── training_agent.py        # scikit-learn ML trainer
├── github_actions_tool.py   # GitHub Actions REST API
│
├── tool_schemas.py          # Pydantic models for all tool inputs/outputs
├── requirements.txt
│
├── tests/                   # pytest suite for tools, planner, executor, router
│   ├── test_executor.py
│   ├── test_orchestration.py
│   ├── test_planner.py
│   ├── test_powershell.py
│   ├── test_kubectl.py
│   ├── test_local_docker.py
│   └── ...
│
└── synapse/                 # React frontend
    └── src/
        ├── App.tsx               # Socket.IO event wiring, two-pane layout
        ├── components/
        │   ├── PlanPanel.tsx     # Live plan with per-step status icons
        │   ├── StepStatusIcon.tsx
        │   ├── ChatDisplay.tsx
        │   ├── InputBar.tsx
        │   ├── EntryScreen.tsx
        │   ├── ParticleBackground.tsx
        │   ├── ScrambledText.tsx
        │   ├── ModelIndicator.tsx
        │   └── TypingIndicator.tsx
        └── hooks/
            └── useScrambleEffect.ts
```

---

## Getting Started

### Prerequisites

- Python 3.11+
- Node.js 18+
- Docker Desktop (for Docker commands)
- kubectl configured (for Kubernetes commands)
- One of: Groq API key, Google Gemini API key, Cerebras API key, or Ollama running locally

### Backend Setup

```bash
cd final-project
pip install -r requirements.txt

# Copy and fill in your credentials
cp .env.example .env
```

**.env variables:**
```env
GROQ_API_KEY=...
GEMINI_API_KEY=...
CEREBRAS_API_KEY=...
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL_1=qwen2.5-coder:7b
OLLAMA_MODEL_2=
MODEL_BACKEND=auto

# SSH to your Linux server
SSH_HOST=192.168.x.x
SSH_USERNAME=your_user
SSH_PASSWORD=
SSH_KEY_PATH=~/.ssh/id_rsa
SSH_PORT=22
SSH_ALLOW_UNKNOWN_HOSTS=false

# AWS / GitHub
AWS_DEFAULT_REGION=ap-south-1
GITHUB_TOKEN=...

# Server
FRONTEND_URL=http://localhost:5173
LOG_LEVEL=INFO

# Notifications
MY_PHONE_NUMBER=...
MY_EMAIL=...
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=...
MAILJET_API_KEY=...
MAILJET_SECRET_KEY=...
MAILJET_SENDER_EMAIL=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

```bash
uvicorn main:app --reload --port 8000
```

### Frontend Setup

```bash
cd synapse
npm install
npm run dev
# Opens at http://localhost:5173
```

Set `VITE_BACKEND_URL` if the backend is not running at `http://localhost:8000`.

### Run Tests

```bash
cd final-project
pytest tests/ -v
```

The repository also includes GitHub Actions CI for backend tests plus frontend lint/build: `.github/workflows/ci.yml`.

---

## UI Overview

The interface has two panes:

**Left panel** — appears when a multi-step command is issued. Shows the plan as a numbered list with live status icons: `○` pending, `◐` running, `✓` done, `✗` failed, `↻` retrying, `★` replanned. On mobile this collapses into an expandable drawer.

**Right panel** — the chat window. User messages bubble on the right, SYNAPSE responses on the left with a scramble-decrypt animation. A typing indicator shows while the agent is processing.

The header shows the active LLM provider (Groq / Gemini / Cerebras / Ollama) and the WebSocket connection status.

---

## Socket.IO Events

| Direction | Event | Payload |
|-----------|-------|---------|
| Client → Server | `execute_natural_command` | `{ command: string, request_id: string }` |
| Server → Client | `command_output` | `{ request_id, data: string }` |
| Server → Client | `plan_generated` | `{ request_id, plan: Plan, replanned?: boolean }` |
| Server → Client | `step_status` | `{ request_id, step_id, status, message? }` |
| Server → Client | `tool_call` | `{ request_id, tool, status, input?, output? }` |
| Server → Client | `token` | `{ request_id, data: string, scope: "final" \| "step" }` |
| Server → Client | `provider_update` | `{ request_id?, provider: string, status?: string }` |

---

<div align="center">

**[ SYNAPSE ]** — *One sentence. Any infrastructure.*
Code- 9SUEZM

</div>
