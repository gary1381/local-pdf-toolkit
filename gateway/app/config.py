from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    ocr_url: str = "http://localhost:8091"
    pdfbox_url: str = "http://localhost:8092"
    qpdf_url: str = "http://localhost:8093"
    structure_url: str = "http://localhost:8094"
    api_key: str = ""

    # Host names the gateway answers to. Blocks DNS-rebinding attacks from web
    # pages. Use "*" only together with API_KEY when serving a network.
    allowed_hosts: str = "127.0.0.1,localhost"

    # Largest single upload accepted, in MB.
    max_upload_mb: int = 200

    # Editing sessions: where they live on disk, how long an idle one is kept,
    # how much disk all of them may use, and how many revisions are kept for undo.
    session_dir: str = "/data/sessions"
    session_ttl_hours: int = 168
    session_max_total_mb: int = 4096
    session_history: int = 40

    @property
    def allowed_host_list(self) -> list[str]:
        return [h.strip() for h in self.allowed_hosts.split(",") if h.strip()]

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


settings = Settings()
