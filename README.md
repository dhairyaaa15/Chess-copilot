# Chess Analysis Extension

A Chrome extension that shows the best move and evaluation for your chess.com games. It uses the Stockfish engine running on a local Python server.

## What is inside

- `backend/` - A Flask server that reads a chess position and asks Stockfish for the best move.
- `frontend/` - A React app that is also built as a Chrome extension. The extension reads the board from chess.com and shows the engine's suggestion.

## What you need

- Python 3.10 or newer
- Node.js 18 or newer
- Google Chrome
- The Stockfish engine (a Windows build is already in `backend/stockfish/`)

## Run the backend

Open a terminal in the `backend` folder.

1. Create and activate a virtual environment:
   ```
   python -m venv venv
   venv\Scripts\activate
   ```
2. Install the Python packages:
   ```
   pip install -r requirements.txt
   ```
3. Start the server:
   ```
   python app.py
   ```

The server will run at `http://localhost:5000`. You can open that URL in a browser to check it is alive.

## Run the frontend in the browser

Open a terminal in the `frontend` folder.

1. Install the Node packages:
   ```
   npm install
   ```
2. Start the dev server:
   ```
   npm run dev
   ```

Open the address printed in the terminal (usually `http://localhost:5173`) to see the app.

## Install as a Chrome extension

1. Build the extension:
   ```
   npm run build
   ```
   This creates a `dist` folder inside `frontend`.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on "Developer mode" (top right).
4. Click "Load unpacked" and pick the `frontend/dist` folder.
5. Make sure the backend is running, then open a game on chess.com. The extension will send the position to the backend and show the best move.

## Common problems

- "Stockfish engine not found": Check that `backend/stockfish/stockfish-windows-x86-64-avx2.exe` exists, or edit the path list in `backend/app.py`.
- The extension shows nothing: Make sure the backend is running on port 5000 and that you are on a supported chess.com URL.
