import hmac
import os
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Annotated, List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import AfterValidator, BaseModel, Field

from backtest import MAX_ORIGINS, run_backtest
from forecast_engine import ENGINE_NAME, ENGINE_VERSION, build_forecast



def _load_env_file(path: Path) -> None:
    """Reads KEY=VALUE lines from ai-service/.env (if present) without overriding real environment variables."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_file(Path(__file__).with_name(".env"))

# Fail fast instead of starting in a silently-insecure state: in production, AI_SERVICE_KEY must be
# set so require_key() below actually rejects unauthenticated calls (unset means open, for local dev).
# NODE_ENV is the same variable backend/index.js checks — set it the same way here (ai-service/.env
# or the process environment) so both services agree on "production" with one flag.
if os.environ.get("NODE_ENV") == "production" and not os.environ.get("AI_SERVICE_KEY"):
    raise SystemExit(
        "FATAL: AI_SERVICE_KEY is not set. Required when NODE_ENV=production so this service "
        "cannot be called by anything but the backend (set the same value in backend/.env)."
    )


def require_key(x_ai_key: Optional[str] = Header(default=None)) -> None:
    """Optional shared secret: when AI_SERVICE_KEY is set, forecast calls must send it as X-AI-Key.
    Unset means open, as before, so local setups keep working without configuration."""
    expected = os.environ.get("AI_SERVICE_KEY", "")
    if not expected:
        return
    if x_ai_key is None or not hmac.compare_digest(x_ai_key.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Missing or invalid X-AI-Key")


app = FastAPI(title="AMPC POS AI Forecasting Microservice")

ISO_DATE = r"^\d{4}-\d{2}-\d{2}$"


def _real_date(value: str) -> str:
    date.fromisoformat(value)  # ValueError for impossible dates such as 2026-13-45 -> 422
    return value


IsoDate = Annotated[str, Field(pattern=ISO_DATE), AfterValidator(_real_date)]


class ProductInput(BaseModel):
    id: int
    sku: str = Field(min_length=1)
    name: str
    category: Optional[str] = None
    stock: int = 0
    minStock: int = 0
    expiryDate: Optional[IsoDate] = None
    createdAt: Optional[IsoDate] = None
    leadTimeDays: int = Field(default=7, ge=1, le=90)   # supplier's days from order to arrival
    onOrder: int = Field(default=0, ge=0)               # units on pending purchase orders


class SaleInput(BaseModel):
    """Units and gross revenue (before discounts) for one product on one store-local day."""
    sku: str
    date: IsoDate
    quantity: int = Field(ge=0)
    revenue: float = Field(ge=0)


class DailyTotalInput(BaseModel):
    """Store-wide gross / discount / net for one store-local day, from the Transaction table."""
    date: IsoDate
    gross: float = Field(ge=0)
    discount: float = Field(ge=0)
    net: float = Field(ge=0)


class StockoutInput(BaseModel):
    """A store-local day on which the product was out of stock (its zero sales say nothing about demand)."""
    sku: str
    date: IsoDate


class ForecastRequest(BaseModel):
    asOf: IsoDate          # today in the store's time zone; history ends yesterday
    timezone: Optional[str] = None
    daysToForecast: int = Field(default=30, ge=1, le=365)
    historyDays: int = Field(default=180, ge=7, le=730)
    products: List[ProductInput]
    sales: List[SaleInput] = []
    dailyTotals: List[DailyTotalInput] = []
    stockouts: List[StockoutInput] = []


class BacktestRequest(ForecastRequest):
    maxOrigins: int = Field(default=MAX_ORIGINS, ge=1, le=120)


@app.get("/health")
def health_check():
    return {
        "status": "online",
        "service": "AI Forecasting Engine",
        "engine": ENGINE_NAME,
        "engineVersion": ENGINE_VERSION,
        "keyRequired": bool(os.environ.get("AI_SERVICE_KEY")),
    }


@app.post("/api/v1/forecast", dependencies=[Depends(require_key)])
def generate_forecast(payload: ForecastRequest):
    result = build_forecast(payload.model_dump(), source="ai-service")
    result["meta"]["generatedAt"] = datetime.now(timezone.utc).isoformat()
    return result


@app.post("/api/v1/backtest", dependencies=[Depends(require_key)])
def backtest(payload: BacktestRequest):
    """Replays the forecast engine over past days and grades it against what actually sold."""
    data = payload.model_dump()
    result = run_backtest(data, max_origins=data["maxOrigins"])
    result["meta"]["generatedAt"] = datetime.now(timezone.utc).isoformat()
    return result
