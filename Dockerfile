# syntax=docker/dockerfile:1

# Use the official UV Python base image with Python 3.13 on Debian Bookworm
ARG PYTHON_VERSION=3.13
FROM ghcr.io/astral-sh/uv:python${PYTHON_VERSION}-bookworm-slim AS base

# Keeps Python from buffering stdout and stderr
ENV PYTHONUNBUFFERED=1

# Create a non-privileged user
ARG UID=10001
RUN adduser \
    --disabled-password \
    --gecos "" \
    --home "/app" \
    --shell "/sbin/nologin" \
    --uid "${UID}" \
    appuser

# Install build dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    python3-dev \
  && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy dependency files
COPY pyproject.toml uv.lock ./

# Install dependencies
RUN uv sync --locked

# Copy application files
# We exclude frontend/ and other unnecessary files via .dockerignore
COPY . .

# Change ownership
RUN chown -R appuser:appuser /app

# Switch to non-privileged user
USER appuser

# Pre-download models/files
RUN uv run agent.py download-files

# Start the agent
CMD ["uv", "run", "agent.py", "start"]
