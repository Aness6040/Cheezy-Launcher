import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { joinPath, getGmlDir } from "./pathUtils";

import { DndContext, closestCenter } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  restrictToVerticalAxis,
  restrictToParentElement,
} from "@dnd-kit/modifiers";

function SortableGMLItem({
  id,
  index,
  enabled,
  onToggle,
  selected,
  selectMode,
  onClick,
  setContextMenu,
  searchActive,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: searchActive });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu((prev) =>
      prev?.modName === id ? null : { x: e.clientX, y: e.clientY, modName: id },
    );
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={onClick}
      onContextMenu={handleContextMenu}
      className={`flex items-center gap-3 p-3 rounded-box border transition-colors cursor-pointer
        ${
          isDragging
            ? "border-primary bg-primary/10"
            : selected
              ? "border-primary bg-primary/20"
              : enabled
                ? "border-base-300 bg-base-100 hover:border-primary"
                : "border-base-300 bg-base-200 opacity-60"
        }`}
    >
      {!searchActive && (
        <span
          className="text-base-content/40 cursor-grab"
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
        >
          ☰
        </span>
      )}
      <span
        className={`text-sm font-medium flex-1 select-none ${!enabled ? "text-base-content/40" : ""}`}
      >
        {id}
      </span>
      <span className="text-xs text-base-content/40 select-none">
        #{index + 1}
      </span>
      <input
        type="checkbox"
        className="checkbox checkbox-sm checkbox-primary"
        checked={enabled}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

function ManageGMLoader({ modsDir, addLog, onDropInstall }) {
  const [mods, setMods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState(null);
  const [selected, setSelected] = useState([]);
  const [selectMode, setSelectMode] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const isDragging = useRef(false);

  const [isDragOver, setIsDragOver] = useState(false);

  const [gmloaderInstalled, setGmloaderInstalled] = useState(false);

  useEffect(() => {
    invoke("gmloader_installed")
      .then(setGmloaderInstalled)
      .catch(() => setGmloaderInstalled(false));
  }, []);

  useEffect(() => {
    const unlistenEnter = listen("tauri://drag-enter", () =>
      setIsDragOver(true),
    );
    const unlistenLeave = listen("tauri://drag-leave", () =>
      setIsDragOver(false),
    );
    const unlistenDrop = listen("tauri://drag-drop", async (event) => {
      setIsDragOver(false);
      for (const path of event.payload.paths) {
        if (/\.(zip|rar|7z)$/i.test(path)) {
          await onDropInstall(path);
        }
      }
    });
    return () => {
      unlistenEnter.then((f) => f());
      unlistenLeave.then((f) => f());
      unlistenDrop.then((f) => f());
    };
  }, [modsDir]);

  const gmlDir = getGmlDir(modsDir);
  const modsJsonPath = joinPath(gmlDir, "mods.json");

  const fetchMods = async () => {
    if (!gmlDir || isDragging.current) return;
    try {
      const folders = await invoke("list_mods", { modsPath: gmlDir });
      let savedOrder = [];
      try {
        const content = await invoke("read_item", { path: modsJsonPath });
        savedOrder = JSON.parse(content);
      } catch (e) {}

      const savedNames = savedOrder.map(([name]) => name);
      const newMods = folders.filter((f) => !savedNames.includes(f));
      const ordered = [
        ...savedOrder.filter(([name]) => folders.includes(name)),
        ...newMods.map((name) => [name, true]),
      ];

      if (newMods.length > 0 || savedOrder.length !== ordered.length) {
        await invoke("edit_item", {
          path: modsJsonPath,
          content: JSON.stringify(ordered, null, 2),
        });
      }

      setMods(ordered);
    } catch (e) {
      // addLog("Error loading GML mods"); useless
    } finally {
      setLoading(false);
    }
  };

  const saveMods = async (newMods) => {
    try {
      await invoke("edit_item", {
        path: modsJsonPath,
        content: JSON.stringify(newMods, null, 2),
      });
    } catch (e) {
      addLog(`Error saving mods.json: ${e}`);
    }
  };

  useEffect(() => {
    fetchMods();
    const interval = setInterval(fetchMods, 2000);
    return () => clearInterval(interval);
  }, [gmlDir]);

  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, []);

  const handleDragStart = () => {
    isDragging.current = true;
  };

  const handleDragEnd = (event) => {
    isDragging.current = false;
    const { active, over } = event;
    if (active.id !== over?.id) {
      setMods((prev) => {
        const oldIndex = prev.findIndex(([name]) => name === active.id);
        const newIndex = prev.findIndex(([name]) => name === over.id);
        const newMods = arrayMove(prev, oldIndex, newIndex);
        saveMods(newMods);
        return newMods;
      });
    }
  };

  const handleToggle = (name) => {
    setMods((prev) => {
      const newMods = prev.map(([n, enabled]) =>
        n === name ? [n, !enabled] : [n, enabled],
      );
      saveMods(newMods);
      return newMods;
    });
  };

  const handleItemClick = (name, e) => {
    if (selectMode) {
      setSelected((prev) =>
        prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
      );
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSelected((prev) =>
        prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
      );
    } else if (e.shiftKey && selected.length > 0) {
      const names = mods.map(([n]) => n);
      const lastSelected = selected[selected.length - 1];
      const lastIndex = names.indexOf(lastSelected);
      const currentIndex = names.indexOf(name);
      const [start, end] = [
        Math.min(lastIndex, currentIndex),
        Math.max(lastIndex, currentIndex),
      ];
      const range = names.slice(start, end + 1);
      setSelected((prev) => [...new Set([...prev, ...range])]);
    } else {
      setSelected((prev) =>
        prev.includes(name) && prev.length === 1 ? [] : [name],
      );
    }
  };

  const handleSelectAll = () => {
    if (selected.length === mods.length) setSelected([]);
    else setSelected(mods.map(([name]) => name));
  };

  const handleSetTopPriority = (targets) => {
    setMods((prev) => {
      const top = prev.filter(([name]) => targets.includes(name));
      const rest = prev.filter(([name]) => !targets.includes(name));
      const newMods = [...top, ...rest];
      saveMods(newMods);
      return newMods;
    });
    setContextMenu(null);
    setSelected([]);
  };

  const handleSetBottomPriority = (targets) => {
    setMods((prev) => {
      const bottom = prev.filter(([name]) => targets.includes(name));
      const rest = prev.filter(([name]) => !targets.includes(name));
      const newMods = [...rest, ...bottom];
      saveMods(newMods);
      return newMods;
    });
    setContextMenu(null);
    setSelected([]);
  };

  const handleToggleSelected = (targets, enable) => {
    setMods((prev) => {
      const newMods = prev.map(([name, enabled]) =>
        targets.includes(name) ? [name, enable] : [name, enabled],
      );
      saveMods(newMods);
      return newMods;
    });
    setContextMenu(null);
    setSelected([]);
  };

  const handleDeleteSelected = async (targets) => {
    setContextMenu(null);
    const confirmed = await window.confirm(`Delete ${targets.length} mod(s)?`);
    if (!confirmed) return;
    for (const name of targets) {
      await invoke("remove_item", { path: joinPath(gmlDir, name) });
    }
    setSelected([]);
    fetchMods();
  };

  const handleOpenFolder = (name) => {
    invoke("open_item", { path: joinPath(gmlDir, name) });
    setContextMenu(null);
  };

  const getTargets = (modName) => {
    if (selected.includes(modName) && selected.length > 0) return selected;
    return [modName];
  };

  const filteredMods = mods
    .map(([name, enabled], index) => ({ name, enabled, index }))
    .filter(({ name }) =>
      name.toLowerCase().includes(searchTerm.toLowerCase()),
    );

  return (
    <div
      className={`flex flex-col h-full gap-3 transition-colors ${isDragOver ? "outline-dashed outline-2 outline-primary bg-primary/5 rounded-box" : ""}`}
    >
      {isDragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
          <p className="text-primary font-bold text-lg">Drop mod to install</p>
        </div>
      )}
      <div className="flex items-center justify-between flex-shrink-0 gap-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">GMLoader Mods</p>

          {!gmloaderInstalled && (
            <span className="badge badge-error badge-sm">
              GMLoader not installed
            </span>
          )}

          {selected.length > 0 && (
            <span className="badge badge-primary badge-sm">
              {selected.length} selected
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* 🔍 SEARCH */}
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search..."
            className="input input-bordered input-xs w-32"
          />

          {/* actions */}
          {selected.length > 0 && (
            <>
              <button
                onClick={() => handleSetTopPriority(selected)}
                className="btn btn-xs btn-outline"
              >
                ↑ Top
              </button>
              <button
                onClick={() => handleSetBottomPriority(selected)}
                className="btn btn-xs btn-outline"
              >
                ↓ Bottom
              </button>
              <button
                onClick={() => handleToggleSelected(selected, true)}
                className="btn btn-xs btn-outline"
              >
                Enable
              </button>
              <button
                onClick={() => handleToggleSelected(selected, false)}
                className="btn btn-xs btn-outline"
              >
                Disable
              </button>
              <button
                onClick={() => handleDeleteSelected(selected)}
                className="btn btn-xs btn-error"
              >
                Delete
              </button>
            </>
          )}

          <button
            onClick={() => {
              setSelectMode((p) => !p);
              setSelected([]);
            }}
            className={`btn btn-xs ${selectMode ? "btn-primary" : "btn-outline"}`}
          >
            {selectMode ? "✓ Select" : "Select"}
          </button>

          <button onClick={handleSelectAll} className="btn btn-xs btn-outline">
            {selected.length === mods.length && mods.length > 0
              ? "Deselect All"
              : "Select All"}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading && <p className="text-sm">Loading...</p>}
        {!loading && mods.length === 0 && (
          <div className="text-center text-xl">
            <h1>Drag your mod file here</h1>
            <p className="text-sm text-secondary-content">
              No GMLoader mods found in {gmlDir}
            </p>
          </div>
        )}
        {!loading && mods.length > 0 && (
          <DndContext
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            modifiers={
              searchTerm
                ? []
                : [restrictToVerticalAxis, restrictToParentElement]
            }
          >
            <SortableContext
              items={filteredMods.map(({ name }) => name)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col gap-2">
                {filteredMods.map(({ name, enabled, index }) => (
                  <SortableGMLItem
                    key={name}
                    id={name}
                    index={index}
                    enabled={enabled}
                    selected={selected.includes(name)}
                    selectMode={selectMode}
                    onToggle={() => handleToggle(name)}
                    onClick={(e) => handleItemClick(name, e)}
                    setContextMenu={setContextMenu}
                    searchActive={!!searchTerm}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {contextMenu && (
        <ul
          className="menu bg-base-100 rounded-box w-56 fixed z-50 shadow-lg"
          style={{
            top: Math.min(contextMenu.y, window.innerHeight - 220),
            left: Math.min(contextMenu.x, window.innerWidth - 224),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <li>
            <a onClick={() => handleOpenFolder(contextMenu.modName)}>
              Open Folder
            </a>
          </li>
          <li>
            <a
              onClick={() =>
                handleSetTopPriority(getTargets(contextMenu.modName))
              }
            >
              Set Top Priority
            </a>
          </li>
          <li>
            <a
              onClick={() =>
                handleSetBottomPriority(getTargets(contextMenu.modName))
              }
            >
              Set Bottom Priority
            </a>
          </li>
          <li>
            <a
              onClick={() =>
                handleToggleSelected(getTargets(contextMenu.modName), true)
              }
            >
              Enable
            </a>
          </li>
          <li>
            <a
              onClick={() =>
                handleToggleSelected(getTargets(contextMenu.modName), false)
              }
            >
              Disable
            </a>
          </li>
          <div className="divider my-0" />
          <li>
            <a
              className="text-error"
              onClick={() =>
                handleDeleteSelected(getTargets(contextMenu.modName))
              }
            >
              🗑️ Delete
            </a>
          </li>
        </ul>
      )}
    </div>
  );
}

export default ManageGMLoader;
