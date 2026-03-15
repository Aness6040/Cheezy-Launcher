import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

function ModCard({ name }) {
  return (
    <div className="rounded-xl border border-gray-600 hover:border-gray-400 transition-colors shadow-md">
      <div className="card-body flex flex-col justify-center items-center p-4">
        <span className="text-3xl mb-2">📦</span>
        <h2 className="card-title text-center truncate text-sm">{name}</h2>
      </div>
    </div>
  );
}

function Tab1({ modsDir }) {
  const [mods, setMods] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchMods = () => {
    if (!modsDir) return;
    invoke("list_mods", { modsPath: modsDir })
      .then((folders) => setMods(folders))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchMods();
    const interval = setInterval(fetchMods, 2000); // vérifie toutes les 2 secondes
    return () => clearInterval(interval); // cleanup au démontage
  }, [modsDir]);

  return (
    <div>
      {loading && <p className="text-gray-400 text-sm">Chargement...</p>}
      {!loading && mods.length === 0 && (
        <p className="text-gray-400 text-sm">Aucun mod trouvé dans {modsDir}</p>
      )}
      {!loading && mods.length > 0 && (
        <div className="grid grid-cols-3 gap-2"> {/* ← petit gap pour esthétique */}
          {mods.map((mod) => (
            <ModCard key={mod} name={mod} />
          ))}
        </div>
      )}
    </div>
  );
}


function App() {
  const [activeTab, setActiveTab] = useState("tab1");
  const [modsDir, setModsDir] = useState(null);

  useEffect(() => {
    invoke("get_mods_dir")
      .then((path) => setModsDir(path))
      .catch(console.error);
  }, []);

  return (
    <div className="">
      <div className="tabs mb-4">
        <a
          className={`tab tab-lifted ${activeTab === "tab1" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("tab1")}
        >
          Tab 1
        </a>
        <a
          className={`tab tab-lifted ${activeTab === "tab2" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("tab2")}
        >
          Tab 2
        </a>
        <a
          className={`tab tab-lifted ${activeTab === "tab3" ? "tab-active" : ""}`}
          onClick={() => setActiveTab("tab3")}
        >
          Tab 3
        </a>
      </div>

      {/* Contenu des tabs */}
      <div className="p-4 bg-gray-800 rounded-lg min-h-[150px]">
        {activeTab === "tab1" && <Tab1 modsDir={modsDir} />}
        {activeTab === "tab2" && <p>Voici le contenu du deuxième onglet.</p>}
        {activeTab === "tab3" && <p>Tu es maintenant sur le troisième onglet.</p>}
      </div>
    </div>
  );
}

export default App;