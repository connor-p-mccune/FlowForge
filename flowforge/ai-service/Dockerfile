# --- Build stage: install Python deps into an isolated venv ---
FROM python:3.11-slim AS build
WORKDIR /app
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --- Runtime stage: copy just the venv + app code ---
FROM python:3.11-slim
WORKDIR /app
COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY . .
EXPOSE 5000
# gunicorn instead of Flask's single-threaded dev server. app.py exposes `app`;
# the long timeout covers slow upstream LLM calls.
#   * $PORT — Railway injects the port to listen on (defaults to 5000 locally).
#   * [::]  — bind IPv6 (dual-stack on Linux) so Railway's IPv6-only private
#             network can reach this internal-only service. Shell form is
#             required so ${PORT} is expanded.
CMD gunicorn -b "[::]:${PORT:-5000}" -w 2 --timeout 120 app:app
