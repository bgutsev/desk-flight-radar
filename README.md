# ADS-B Radar Tracker

A real-time flight tracking application that combines a robust backend data pipeline with a high-performance, hardware-inspired frontend. The project fetches live ADS-B data and visualizes it through an authentic 60fps Canvas-based Plan Position Indicator (PPI) radar display.

## 🚀 Key Features

- **Real-Time Radar Display**: HTML5 `<canvas>` implementation featuring a smooth 60fps sweeping radar beam and accurate aircraft positioning
- **Comprehensive Flight Data**: Dual-pane UI displaying real-time telemetry, enriched route data (origin/destination), and aircraft thumbnails
- **Resilient Data Pipeline**: Built-in fault tolerance with in-memory caching to seamlessly handle upstream 502 errors from external data providers
- **Customizable & Persistent UI**: User preferences saved via localStorage, with base configurations managed through `static/config.js`
- **Ground Classification**: Suppresses tarmac aircraft and ground vehicles near the airport using altitude trend analysis and proximity gating
- **Offline Mode**: Mock data support for grading and demonstrations without live data sources

## 🛠️ Tech Stack & Architecture

### Backend
- **Framework**: FastAPI
- **Architecture**: Modular `app/` directory structure for clean separation of concerns
- **Data Sources**: adsb.fi (primary telemetry), hexdb, and adsbdb (metadata and route enrichment)
- **Modules**:
  - `app/main.py` - FastAPI application entry point
  - `app/config.py` - Configuration management
  - `app/clients/flight_source.py` - ADS-B data fetching
  - `app/clients/enrichment.py` - Route and metadata enrichment
  - `app/utils/geo.py` - Geographic calculations
  - `app/classifier.py` - Ground vs. air classification

### Frontend
- **Rendering**: HTML5 Canvas API (custom rendering engine for radar sweep and contact plotting)
- **State Management**: Vanilla JavaScript with localStorage integration
- **Styling**: Retro green-on-dark aesthetic with responsive layout
- **Canvas Radar**: Layered over device image using `position: absolute`

## ⚙️ Installation & Setup

### Prerequisites
- Python 3.9 or higher
- pip (Python package manager)

### Quick Start

1. **Clone the repository**:
   ```bash
   git clone https://github.com/bgutsev/desk-flight-radar
   cd desk-flight-radar
   ```

2. **Create a virtual environment** (optional but recommended):
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # On Windows: .venv\Scripts\activate
   ```

3. **Install backend dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Configure the application** (optional):
   - Edit `static/config.js` to customize frontend behaviors
   - The application works out-of-the-box with default settings

5. **Run the development server**:
   ```bash
   uvicorn app.main:app --reload
   ```
   Navigate to [http://localhost:8000](http://localhost:8000) in your browser to view the radar.

## 🧪 Testing & Code Quality

- **Run tests**: `pytest -v`
- **Lint code**: `ruff check .`
- **Auto-format**: `ruff format .`


### Technical & Project Challenges

**Route Data Enrichment**: Integrating complex flight route data presented a significant challenge due to frequent 404 errors from external APIs. This was resolved by engineering a robust fallback logic system that dynamically combines data from both hexdb and adsbdb to ensure consistent data delivery.

**UI/UX Requirement Alignment**: Managing inconsistencies between AI-generated frontend outputs and specific UI/UX requirements required continuous iterative prompting to align the visual layout and data presentation exactly with the intended vision.

**Ground Classification**: Distinguishing real aircraft from ground vehicles and parked planes required combining barometric altitude, vertical rate, and proximity to the airport. The solution uses per-aircraft altitude history across multiple ADS-B readings to confirm genuine takeoffs before showing an aircraft on radar.

## 📝 Requirements

The project uses the following main dependencies (see `requirements.txt` for the complete list):
- **FastAPI** - Web framework
- **uvicorn** - ASGI server
- **httpx/httpcore** - HTTP clients for data fetching
- **pydantic** - Data validation
- **pytest** - Testing framework
- **ruff** - Linting and formatting

## 🔄 Offline Mode

The application includes built-in mock data support for offline demonstrations. This is essential for grading scenarios where live data sources may not be available.

## 📄 License

[Add your license information here]

## 👤 Author

Borislav Gutsev (Борислав Гуцев)
