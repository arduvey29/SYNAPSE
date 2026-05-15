from dotenv import load_dotenv
load_dotenv()

import asyncio
import logging
import os

import socketio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.tools import Tool
from langgraph.prebuilt import create_react_agent
from pydantic import BaseModel, Field

from linux_agent import LinuxAgent
from docker_agent import DockerTool as DockerAgent
from aws_agent import AWSAgent
from training_agent import TrainingAgent
from notification_agent import NotificationAgent
from model_router import ModelRouter
from agent_memory import agent_memory
from agent_prompts import build_prompt

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("synapse.main")

class RemoteFileInput(BaseModel):
    remote_path: str = Field(description="Remote file path, e.g., '/path/to/file'")
    content: str = Field(description="File content to write at the remote path")
    mode: int = Field(default=None, description="Optional file mode/permissions, e.g., 0o755")

class LocalTrainerInput(BaseModel):
    file_path: str = Field(description="Local path to the CSV file for training")
    target_column: str = Field(description="Column name the model should predict")

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
aws_agent = AWSAgent()
training_agent = TrainingAgent()
notification_agent = NotificationAgent()

tools = [
    Tool(name="RunShellCommand", func=linux_agent.run_command,
         description="Run a single Linux shell command on the remote server."),
    Tool(name="CreateRemoteFile", func=linux_agent.create_file,
         args_schema=RemoteFileInput,
         description="Create a file with specific content at a given remote path."),
    Tool(name="RunDockerCommand", func=docker_agent.run_command,
         description="Run a single Docker CLI command on the remote server via SSH."),
    Tool(name="RunAWSCommand", func=aws_agent.run_cli,
         description="Execute any AWS CLI command."),
    Tool(name="TrainStartupModel", func=training_agent.train_startup_model,
         description="Train the ML model on the 50_startup.csv dataset. Takes no arguments."),
    Tool(name="SendEmailNotification", func=notification_agent.notify_by_email,
         description="Send an email notification with subject and body."),
    Tool(name="SendSMSNotification", func=notification_agent.notify_by_sms,
         description="Send an SMS notification."),
    Tool(name="SendTelegramNotification", func=notification_agent.notify_by_telegram,
         description="Send a Telegram notification."),
]

router = ModelRouter()
llm = router.get_llm()
agent_executor = create_react_agent(llm, tools)
logger.info(f"SYNAPSE started. LLM provider: {router.current_provider}")

@sio.event
async def connect(sid, environ):
    logger.info(f"Client connected: {sid}")
    await sio.emit("provider_update", {"provider": router.current_provider}, to=sid)

@sio.event
async def disconnect(sid):
    logger.info(f"Client disconnected: {sid}")

@sio.on("execute_natural_command")
async def handle_command(sid, data):
    query = data.get("command", "").strip()
    if not query:
        return

    session_id = sid
    agent_memory.add(session_id, role="user", content=query)
    session_context = agent_memory.get_context(session_id)

    system_prompt = build_prompt(session_context=session_context)
    agent = create_react_agent(llm, tools, state_modifier=system_prompt)

    full_response = []
    try:
        async for event in agent.astream_events(
            {"messages": [{"role": "user", "content": query}]},
            version="v2",
        ):
            kind = event["event"]

            if kind == "on_chat_model_stream":
                chunk = event["data"]["chunk"]
                if chunk.content:
                    await sio.emit("token", {"data": chunk.content}, to=sid)
                    full_response.append(chunk.content)

            elif kind == "on_tool_start":
                await sio.emit("tool_call", {
                    "tool": event["name"],
                    "status": "running",
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
                    "tool": tool_name,
                    "status": "done",
                    "output": tool_output[:200],
                }, to=sid)

        final = "".join(full_response)
        agent_memory.add(session_id, role="agent", content=final[:300])
        await sio.emit("command_output", {"data": final}, to=sid)

    except Exception as e:
        error_msg = str(e)
        logger.error(f"Agent error sid={sid}: {error_msg}")
        if any(w in error_msg.lower() for w in ["429", "rate limit", "quota"]):
            await sio.emit("command_output", {
                "data": f"Provider {router.current_provider} hit rate limit. Please retry."
            }, to=sid)
        else:
            await sio.emit("command_output", {"data": f"Error: {error_msg}"}, to=sid)
