# ADS-B Radar Tracker

(System for early alert B.G.G. Alert 🙂)
A real-time flight tracking application that combines a robust backend data pipeline with a high-performance, hardware-inspired frontend. The project fetches live, unencrypted public ADS-B data and visualizes it through an authentic 60fps Canvas-based Plan Position Indicator (PPI) radar display.

The Project is inspired by an actual physical DYI model: https://makerworld.com/en/models/2872376-esp32-plane-radar-live-ads-b-on-a-round-display

Screenshot

<img width="1943" height="1043" alt="image" src="https://github.com/user-attachments/assets/c1cbf36c-4983-4d32-b8d1-affd4df92942" />

---

## ⚠️ Disclaimer & Ethical Use Notice

**For Educational, Research, and Hobbyist Purposes Only**

This software is an open-source technical experiment developed strictly for educational analysis, portfolio demonstration, and aviation enthusiasm. 

* **Public & Unencrypted Data Only:** This application relies entirely on publicly broadcasted, unencrypted radio signals (ADS-B and Mode S) aggregated and made available by community-driven open networks (such as `adsb.fi`). It does not decrypt, intercept, or bypass any secure, private, or restricted military/governmental communications.
* **Neutral Tooling Architecture:** This repository does not include, hardcode, or distribute any tracking lists, target parameters, or identifiers for specific military, government, or private aircraft. The software is a generic data visualization engine; any filtering or alerting criteria are entirely configured by the end-user.
* **No Liability (Provided "AS IS"):** In accordance with the open-source licensing model, this software is provided "as is" without warranties of any kind. The author assumes no responsibility or liability for how individuals choose to deploy, configure, or utilize this tool, nor for any decisions made based on the visualized data. Users are solely responsible for ensuring compliance with their local legal frameworks regarding data access and monitoring.

---

## 🚀 Key Features

* **Real-Time Radar Display**: HTML5 `<canvas>` implementation featuring a smooth 60fps sweeping radar beam and accurate aircraft positioning.
* **Comprehensive Flight Data**: Dual-pane UI displaying real-time telemetry, enriched route data (origin/destination), and aircraft thumbnails.
* **Resilient Data Pipeline**: Built-in fault tolerance with in-memory caching to seamlessly handle upstream 502 or 404 errors from external data providers.
* **Customizable & Persistent UI**: User-defined tracking parameters (such as custom coordinates and radius) are saved via browser `localStorage` to keep the core application agnostic and customizable.
* **Ground Classification**: Advanced altitude trend analysis and proximity gating to filter out tarmac ground vehicles and stationary parked aircraft near airports.
* **Offline Demo Mode**: Comprehensive mock data support allowing full testing and evaluation of the frontend radar sweep without requiring live API access.

## 🛠️ Tech Stack & Architecture

### Backend
* **Framework**: FastAPI (Asynchronous Python Web Framework)
* **Data Sources**: Aggregated public telemetry via `adsb.fi`, with metadata enrichment provided via public `hexdb` and `adsbdb` open endpoints.
* **Architecture**: Modular and decoupled layout:
  * `app/main.py` - FastAPI application entry point and routing.
  * `app/config.py` - Environment and system configuration.
  * `app/clients/` - Asynchronous HTTP clients utilizing `httpx` for efficient telemetry and metadata fetching.
  * `app/utils/geo.py` - Great-circle distance and geographic bounding box calculations.
  * `app/classifier.py` - State machine tracking per-aircraft altitude history to determine genuine airborne vs. ground status.

### Frontend
* **Rendering**: Vanilla HTML5 Canvas API using a localized rendering loop optimized for smooth 60fps animations.
* **State & Configuration**: Completely decoupled client-side state management using vanilla JavaScript and persistent browser storage.
* **Aesthetics**: Responsive, high-fidelity hardware-inspired terminal layout with a desaturated retro-green color palette.

## ⚙️ Installation & Setup

### Prerequisites
* Python 3.9 or higher
* pip (Python package manager)

### Quick Start

1. **Clone the repository**:
   ```bash
   git clone https://github.com/bgutsev/desk-flight-radar
   cd desk-flight-radar
   ```

2. **Create and activate a virtual environment**:
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # On Windows use: .venv\Scripts\activate
   ```

3. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Run the development server**:
   ```bash
   uvicorn app.main:app --reload
   ```

5. **Access the application**:
   Open your browser and navigate to http://localhost:8000. Use the built-in UI configuration panel to adjust your tracking center point (Latitude/Longitude) and detection radius.

## 🧪 Testing & Code Quality

The project maintains high code quality standards through automated linting and unit testing.

* **Run Test Suite**: `pytest -v`
* **Lint Codebase**: `ruff check .`
* **Code Formatting**: `ruff format .`

## 📄 License

This project is open-source and licensed under the [MIT License](LICENSE) — meaning it is free to use, modify, and distribute, provided that the original copyright and permission notice are included, while explicitly absolving the author of any liability.

---
**Author:** Borislav Gutsev (Борислав Гуцев)
