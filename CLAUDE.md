# Claude Code Rules & Conventions

## General AI Behavior
- KEEP ALL RESPONSES STRICTLY CONCISE AND TO THE POINT. No fluff or lengthy explanations.
- Think step-by-step before implementing complex logic.
- Do not delete existing features or mock data unless explicitly told to do so.

## Tech Stack & Architecture
- **Backend:** Python / FastAPI. Maintain a clean module split (e.g., config, geo utils, flight client).
- **Frontend:** Vanilla HTML/CSS/JS. Use `<canvas>` for the radar, layered over a static device image using `position: absolute` inside a round-clipped container.
- **Data Strategy:** The system MUST support an offline/mock mode via sample JSON for grading and offline demonstrations. 

## Code Style
- All code, filenames, variables, and comments MUST be in English.
- Python: Enforce strict typing. Use `ruff` for all linting and formatting.
- Frontend: Use modern ES6+ features. Keep styling retro (green-on-dark).

## Project Commands
- Run backend: `uvicorn app.main:app --reload`
- Lint code: `ruff check .`
- Auto-format code: `ruff format .`
- Run tests: `pytest -v`