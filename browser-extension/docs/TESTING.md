# Testing Guide

## Playwright
End-to-end tests use Playwright to verify the extension overlay and picker functionality across Chromium, Firefox, and Edge. Tests are located in `src/tests/e2e/` and require a built extension package. Run with `pnpm test:e2e`.

## Vitest
Unit tests use Vitest and cover core logic including capture, classification, download interception, and release validation. Tests are in `src/tests/unit/` and run with `pnpm test:unit`. Vitest is configured in `vitest.config.ts`.

## Pytest
Python-based tests validate the build system, native messaging bridge, and deployment scripts. These tests use pytest and are located in the `tests/` directory. Run with `pnpm test:python` or directly with `pytest`.
