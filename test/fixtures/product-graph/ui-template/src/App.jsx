import { useEffect, useState } from "react";

export function App() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    loadItems();
  }, []);
  function handleSave() {
    return open;
  }
  return (
    <main>
      <button id="save" onClick={handleSave}>Save</button>
      <button onClick={() => setOpen(!open)}>Toggle</button>
      <img src="a.png" onLoad={markLoaded} />
      <SettingsDialog open={open} />
    </main>
  );
}

function loadItems() {
  return [];
}

function markLoaded() {
  return true;
}

export function SettingsDialog() {
  return (
    <div>
      <button onClick={closeDialog}>Close</button>
    </div>
  );
}

function closeDialog() {
  return false;
}
