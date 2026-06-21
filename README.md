ADS-B Radar Tracker
A real-time flight tracking application that combines a robust backend data pipeline with a high-performance, hardware-inspired frontend. The project fetches live ADS-B data and visualizes it through an authentic 60fps Canvas-based Plan Position Indicator (PPI) radar display.

🚀 Key Features
Real-Time Radar Display: HTML5 <canvas> implementation featuring a smooth 60fps sweeping radar beam and accurate aircraft positioning.

Comprehensive Flight Data: Dual-pane UI displaying real-time telemetry, enriched route data (origin/destination), and aircraft thumbnails.

Resilient Data Pipeline: Built-in fault tolerance with in-memory caching to seamlessly handle upstream 502 errors from external data providers.

Customizable & Persistent UI: User preferences are saved via localStorage, with base configurations easily managed through an external static/config.js file.

🛠️ Tech Stack & Architecture
Backend

Framework: FastAPI

Architecture: Modular app/ directory structure for clean separation of concerns.

Data Sources: adsb.fi (primary telemetry), hexdb, and adsbdb (metadata and route enrichment).

Frontend

Rendering: HTML5 Canvas API (custom rendering engine for the radar sweep and contact plotting).

State Management: Vanilla JavaScript with localStorage integration.

Technical & Project Challenges
Route Data Enrichment: Integrating complex flight route data presented a significant challenge due to frequent 404 errors from external APIs. This was resolved by engineering a robust fallback logic system that dynamically combines data from both hexdb and adsbdb to ensure consistent data delivery.

UI/UX Requirement Alignment: A secondary challenge was managing significant inconsistencies between the AI's initial frontend outputs and my specific UI/UX requirements. Resolving these mismatches required continuous iterative prompting to align the visual layout and data presentation exactly with my intended vision.

⚙️ Installation & Setup
1. Clone the repository:

Bash
git clone https://github.com/bgutsev/desk-flight-radar
cd desk-flight-radar

2. Install backend dependencies:

Bash
pip install -r requirements.txt
3. Configure the application:

Adjust default frontend behaviors in static/config.js.

[Add any other necessary environment variables or config steps here]

4. Run the development server:

Bash
uvicorn app.main:app --reload
Navigate to http://localhost:8000 in your browser to view the radar.
