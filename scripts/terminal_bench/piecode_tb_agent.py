import base64
import os
import shlex
from pathlib import Path

from terminal_bench.agents.installed_agents.abstract_installed_agent import (
    AbstractInstalledAgent,
)
from terminal_bench.terminal.models import TerminalCommand


class PieCodeTBenchAgent(AbstractInstalledAgent):
    @staticmethod
    def name() -> str:
        return "piecode"

    def __init__(self, model_name: str | None = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._model_name = (model_name or "").split("/")[-1].strip()
        self._host_repo = Path(
            kwargs.get("piecode_host_path")
            or os.environ.get("PIECODE_HOST_PATH")
            or "/Users/reeze/piecode"
        )
        self._host_settings = Path(
            kwargs.get("piecode_settings_path")
            or os.environ.get("PIECODE_SETTINGS_PATH")
            or "/Users/reeze/.piecode/settings.json"
        )
        self._host_codex_auth = Path(
            kwargs.get("codex_auth_path")
            or os.environ.get("CODEX_AUTH_PATH")
            or "/Users/reeze/.codex/auth.json"
        )
        self._container_home = kwargs.get("container_home", "/root")
        self._container_codex_home = kwargs.get(
            "codex_home", f"{self._container_home}/.codex"
        )
        self._container_settings_path = kwargs.get(
            "container_settings_path", f"{self._container_home}/.piecode/settings.json"
        )

    @property
    def _env(self) -> dict[str, str]:
        return {
            "HOME": self._container_home,
            "CODEX_HOME": self._container_codex_home,
            "PIECODE_SETTINGS_FILE": self._container_settings_path,
            "PIECODE_DISABLE_CODEX_CLI": "1",
        }

    @property
    def _install_agent_script_path(self) -> Path:
        return Path(__file__).with_name("piecode_tb_setup.sh")

    def perform_task(self, instruction, session, logging_dir=None):
        required = [
            self._host_repo / "src",
            self._host_repo / "package.json",
            self._host_repo / "package-lock.json",
        ]
        missing = [str(p) for p in required if not p.exists()]
        if missing:
            raise FileNotFoundError(
                "PieCode source files not found for benchmark install: "
                + ", ".join(missing)
            )

        if not self._host_settings.exists():
            raise FileNotFoundError(
                f"PieCode settings file not found: {self._host_settings}"
            )

        session.copy_to_container(required, container_dir="/installed-agent/piecode")

        settings_dir = str(Path(self._container_settings_path).parent)
        session.copy_to_container(
            self._host_settings,
            container_dir=settings_dir,
            container_filename=Path(self._container_settings_path).name,
        )

        # Optional Codex auth passthrough as fallback if settings choose codex.
        if self._host_codex_auth.exists():
            session.copy_to_container(
                self._host_codex_auth,
                container_dir=self._container_codex_home,
                container_filename="auth.json",
            )

        return super().perform_task(instruction, session, logging_dir=logging_dir)

    def _run_agent_commands(self, instruction: str):
        encoded = base64.b64encode(instruction.encode("utf-8")).decode("ascii")

        model_arg = (
            "cmd.extend(['--model', os.environ['TB_MODEL']]) "
            "if os.environ.get('TB_MODEL') else None;"
        )
        py = (
            "import base64,os,subprocess,sys;"
            "ins=base64.b64decode(os.environ['TB_INSTR_B64']).decode('utf-8','replace');"
            "cmd=['node','/installed-agent/piecode/cli.js'];"
            f"{model_arg}"
            "cmd.extend(['--prompt',ins]);"
            "p=subprocess.Popen(cmd,cwd='/app',stdin=subprocess.DEVNULL);"
            "p.wait();"
            "sys.exit(p.returncode)"
        )

        cmd = (
            f"TB_INSTR_B64={shlex.quote(encoded)} "
            f"TB_MODEL={shlex.quote(self._model_name)} "
            f"python3 -c {shlex.quote(py)}"
        )

        return [
            TerminalCommand(
                command=cmd,
                min_timeout_sec=0.0,
                max_timeout_sec=float("inf"),
                block=True,
                append_enter=True,
            )
        ]
