from dotenv import load_dotenv
load_dotenv()

import asyncio
import logging
import os
from typing import Optional

import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.tools import Tool
from langgraph.prebuilt import create_react_agent
from pydantic import BaseModel, Field

from linux_agent import LinuxAgent
from docker_agent import LocalDockerAgent as DockerAgent
from kubectl_agent import LocalKubectlAgent
from aws_agent import AWSAgent
from training_agent import TrainingAgent
from notification_agent import NotificationAgent
from github_actions_tool import github_actions_tool
from tool_schemas import GitHubActionsInput, KubectlCommandInput
from model_router import ModelRouter
from agent_memory import agent_memory
from agent_prompts import build_prompt
from planner import Planner
from executor import Executor
from orchestration import needs_planning, compose_final_answer

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("synapse.main")

class RemoteFileInput(BaseModel):
    remote_path: str = Field(description="Remote file path, e.g., '/path/to/file'")
    content: str = Field(description="File content to write at the remote path")
    mode: int = Field(default=None, description="Optional file mode/permissions, e.g., 0o755")

class LocalTrainerInput(BaseModel):
    file_path: str = Field(description="Local path to the CSV file for training")
    target_column: str = Field(description="Column name the model should predict")

class DockerCommandInput(BaseModel):
    command: str = Field(description="The Docker CLI arguments to run (everything after 'docker'). Examples: 'ps -a', 'pull nginx:latest', 'logs abc123', 'stop mycontainer'")

class ShellCommandInput(BaseModel):
    command: str = Field(description="The Linux shell command to run on the remote server. Example: 'ls /var/log', 'cat /etc/os-release'")

class AWSCommandInput(BaseModel):
    command: str = Field(description="AWS CLI arguments (everything after 'aws'). Example: 's3 ls', 'ec2 describe-instances --output table'")

class KubectlCommandInputSchema(BaseModel):
    command: str = Field(description="kubectl arguments (everything after 'kubectl'). Example: 'get pods', 'apply -f deploy.yml'")

class TrainModelInput(BaseModel):
    file_path: Optional[str] = Field(default=None, description="Path to the CSV dataset on this machine. Omit to use the default 50_startup.csv.")
    target_column: Optional[str] = Field(default=None, description="Column to predict. Omit to use the default 'Profit'.")

class EmailNotificationInput(BaseModel):
    subject: str = Field(description="Email subject line")
    body: str = Field(description="Email body text")

class SMSNotificationInput(BaseModel):
    message: str = Field(description="SMS message text")

class TelegramNotificationInput(BaseModel):
    message: str = Field(description="Telegram message text")

fastapi_app = FastAPI(title="SYNAPSE Control Plane")
fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:5173")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)

linux_agent = LinuxAgent()
docker_agent = DockerAgent()
kubectl_agent = LocalKubectlAgent()
aws_agent = AWSAgent()
training_agent = TrainingAgent()
notification_agent = NotificationAgent()

tools = [
    Tool(name="RunShellCommand", func=linux_agent.run_command,
         args_schema=ShellCommandInput,
         description="Run a single Linux shell command on the remote server via SSH."),
    Tool(name="CreateRemoteFile", func=linux_agent.create_file,
         args_schema=RemoteFileInput,
         description="Create a file with specific content at a given remote path."),
    Tool(name="RunDockerCommand", func=docker_agent.run_command,
         args_schema=DockerCommandInput,
         description="Run a Docker CLI command on the local host. Docker Desktop must be installed and running."),
    Tool(name="RunKubectlCommand", func=kubectl_agent.run_command,
         args_schema=KubectlCommandInputSchema,
         description="Run a kubectl command on the local host. Kubernetes context must be configured on the host."),
    Tool(name="RunAWSCommand", func=aws_agent.run_cli,
         args_schema=AWSCommandInput,
         description="Execute any AWS CLI command. Pass everything after 'aws'."),
    Tool(name="TrainStartupModel", func=training_agent.train_startup_model,
         args_schema=TrainModelInput,
         description="Train the ML model on a CSV dataset. Omit arguments to use the default 50_startup.csv / Profit target."),
    Tool(name="SendEmailNotification", func=notification_agent.notify_by_email,
         args_schema=EmailNotificationInput,
         description="Send an email notification. Requires subject and body."),
    Tool(name="SendSMSNotification", func=notification_agent.notify_by_sms,
         args_schema=SMSNotificationInput,
         description="Send an SMS notification. Requires message text."),
    Tool(name="SendTelegramNotification", func=notification_agent.notify_by_telegram,
         args_schema=TelegramNotificationInput,
         description="Send a Telegram notification. Requires message text."),
    Tool(
        name="GitHubActions",
        func=github_actions_tool,
        args_schema=GitHubActionsInput,
        description="Trigger GitHub Actions workflows, check run status, or list recent runs.",
    ),
]

router = ModelRouter()
llm = router.get_llm()
agent_executor = create_react_agent(llm, tools)
logger.info(f"SYNAPSE started. LLM provider: {router.current_provider}")

docker_err = docker_agent.detect()
if docker_err:
    logger.warning("Docker not available: %s", docker_err)
kubectl_err = kubectl_agent.detect()
if kubectl_err:
    logger.warning("kubectl not available: %s", kubectl_err)

planner = Planner(router=router, tool_names=[t.name for t in tools])

@sio.event
async def connect(sid, environ):
    logger.info(f"Client connected: {sid}")
    await sio.emit("provider_update", {"provider": router.current_provider}, to=sid)

@sio.event
async def disconnect(sid):
    logger.info(f"Client disconnected: {sid}")

async def _run_single_react(sid, session_id, query, session_context):
    system_prompt = build_prompt(session_context=session_context)
    agent = create_react_agent(llm, tools, state_modifier=system_prompt)
    full_response = []
    try:
        async for event in agent.astream_events(
            {"messages": [{"role": "user", "content": query}]}, version="v2",
        ):
            kind = event["event"]
            if kind == "on_chat_model_stream":
                chunk = event["data"]["chunk"]
                if chunk.content:
                    await sio.emit("token", {"data": chunk.content}, to=sid)
                    full_response.append(chunk.content)
            elif kind == "on_tool_start":
                await sio.emit("tool_call", {
                    "tool": event["name"], "status": "running",
                    "input": str(event["data"].get("input", {}))[:200],
                }, to=sid)
            elif kind == "on_tool_end":
                tool_name = event["name"]
                tool_output = str(event["data"].get("output", ""))
                agent_memory.add(
                    session_id, role="tool", content=tool_output,
                    tool_name=tool_name, tool_result_summary=tool_output[:150],
                )
                await sio.emit("tool_call", {
                    "tool": tool_name, "status": "done",
                    "output": tool_output[:200],
                }, to=sid)
        final = "".join(full_response)
        agent_memory.add(session_id, role="agent", content=final[:300])
        await sio.emit("command_output", {"data": final}, to=sid)
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Agent error sid={sid}: {error_msg}")
        await sio.emit("command_output", {"data": f"Error: {error_msg}"}, to=sid)


@sio.on("execute_natural_command")
async def handle_command(sid, data):
    query = data.get("command", "").strip()
    if not query:
        return
    session_id = sid

    agent_memory.add(session_id, role="user", content=query)
    session_context = agent_memory.get_context(session_id)

    if not needs_planning(query):
        await _run_single_react(sid, session_id, query, session_context)
        return

    plan = planner.plan(query, session_context)
    if plan is None:
        logger.warning("Planner failed; falling back to single-ReAct")
        await _run_single_react(sid, session_id, query, session_context)
        return

    await sio.emit("plan_generated", {"plan": plan.model_dump()}, to=sid)
    executor = Executor(
        llm=llm, tools=tools, memory=agent_memory,
        sio=sio, sid=sid, planner=planner,
    )
    try:
        results = await executor.run_plan(plan, session_id)
        final = compose_final_answer(plan, results)
        agent_memory.add(session_id, role="agent", content=final[:300])
        await sio.emit("command_output", {"data": final}, to=sid)
    except Exception as e:
        error_msg = str(e)
        logger.error(f"Executor error sid={sid}: {error_msg}")
        await sio.emit("command_output", {"data": f"Error: {error_msg}"}, to=sid)
