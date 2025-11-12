import { useState, useEffect } from 'react'
import './App.css'

function App() {
  const [settings, setSettings] = useState({
    enabled: true,
    depth: 15,
    backendUrl: 'http://localhost:5000'
  });
  const [status, setStatus] = useState('loading');
  const [lastAnalysis, setLastAnalysis] = useState(null);

  // Load settings from Chrome storage
  useEffect(() => {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.sync.get(['chessAnalysisSettings'], (result) => {
        if (result.chessAnalysisSettings) {
          setSettings({ ...settings, ...result.chessAnalysisSettings });
        }
        setStatus('ready');
      });
    } else {
      setStatus('ready');
    }
  }, []);

  // Save settings to Chrome storage
  const saveSettings = (newSettings) => {
    setSettings(newSettings);
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.sync.set({ chessAnalysisSettings: newSettings });
    }
  };

  const handleToggleEnabled = () => {
    const newSettings = { ...settings, enabled: !settings.enabled };
    saveSettings(newSettings);
  };

  const handleDepthChange = (newDepth) => {
    const newSettings = { ...settings, depth: newDepth };
    saveSettings(newSettings);
  };

  const handleBackendUrlChange = (newUrl) => {
    const newSettings = { ...settings, backendUrl: newUrl };
    saveSettings(newSettings);
  };

  const testConnection = async () => {
    setStatus('testing');
    try {
      const response = await fetch(`${settings.backendUrl}/health`);
      const data = await response.json();
      if (data.status === 'ok') {
        setStatus('connected');
      } else {
        setStatus('error');
      }
    } catch (error) {
      setStatus('error');
    }
  };

  if (status === 'loading') {
    return (
      <div className="w-80 h-60 p-4 bg-gray-900 text-white">
        <div className="text-center">
          <div className="text-lg font-bold mb-2">Chess Analysis</div>
          <div className="text-sm">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-80 min-h-60 p-4 bg-gray-900 text-white">
      {/* Header */}
      <div className="text-center mb-4">
        <h1 className="text-xl font-bold text-blue-400 mb-1">Chess Analysis</h1>
        <div className="text-xs text-gray-400">AI-powered move analysis for Chess.com</div>
      </div>

      {/* Status Indicator */}
      <div className="mb-4 p-2 rounded bg-gray-800">
        <div className="flex items-center justify-between">
          <span className="text-sm">Status:</span>
          <div className="flex items-center">
            <div className={`w-2 h-2 rounded-full mr-2 ${
              status === 'connected' ? 'bg-green-400' : 
              status === 'testing' ? 'bg-yellow-400' : 
              'bg-red-400'
            }`}></div>
            <span className="text-xs capitalize">{status}</span>
          </div>
        </div>
      </div>

      {/* Main Toggle */}
      <div className="mb-4 p-3 rounded bg-gray-800">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Enable Analysis</span>
          <button
            onClick={handleToggleEnabled}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              settings.enabled ? 'bg-blue-600' : 'bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                settings.enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Analysis Depth */}
      <div className="mb-4 p-3 rounded bg-gray-800">
        <div className="mb-2">
          <span className="text-sm font-medium">Analysis Depth: {settings.depth}</span>
        </div>
        <div className="flex gap-2">
          {[10, 15, 20].map((depth) => (
            <button
              key={depth}
              onClick={() => handleDepthChange(depth)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                settings.depth === depth
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {depth}
            </button>
          ))}
        </div>
        <div className="text-xs text-gray-400 mt-1">
          Higher depth = stronger analysis but slower
        </div>
      </div>

      {/* Backend Configuration */}
      <div className="mb-4 p-3 rounded bg-gray-800">
        <div className="mb-2">
          <span className="text-sm font-medium">Backend URL</span>
        </div>
        <input
          type="text"
          value={settings.backendUrl}
          onChange={(e) => handleBackendUrlChange(e.target.value)}
          className="w-full px-2 py-1 text-xs bg-gray-700 border border-gray-600 rounded text-white focus:border-blue-500 focus:outline-none"
          placeholder="http://localhost:5000"
        />
        <button
          onClick={testConnection}
          className="mt-2 w-full px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs font-medium transition-colors"
        >
          Test Connection
        </button>
      </div>

      {/* Instructions */}
      <div className="p-3 rounded bg-gray-800 text-xs text-gray-300">
        <div className="font-medium mb-1">Instructions:</div>
        <ul className="list-disc list-inside space-y-1">
          <li>Go to a chess.com game page</li>
          <li>Best moves will appear automatically</li>
          <li>Analysis updates after each move</li>
        </ul>
      </div>
    </div>
  );
}

export default App