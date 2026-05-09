import React, { useState, useEffect } from "react";
import "./App.css";
import { openUrl } from "@tauri-apps/plugin-opener";

function CatDropdown({ categories, selectedCat, onSelect }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef(null);

  const selected =
    categories.find((c) => c._idRow === selectedCat) || categories[0];

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="btn btn-sm btn-outline flex items-center gap-2 min-w-32"
      >
        {selected?._sIconUrl && (
          <img
            src={selected._sIconUrl}
            alt=""
            className="w-4 h-4 object-contain"
          />
        )}
        <span className="truncate max-w-24">{selected?._sName || "All"}</span>
        <span className="ml-auto">▾</span>
      </button>
      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 bg-base-100 border border-base-300 rounded shadow-lg max-h-64 overflow-y-auto min-w-48">
          {categories.map((cat) => (
            <button
              key={cat._idRow}
              onClick={() => {
                onSelect(cat._idRow);
                setOpen(false);
              }}
              className={`flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-base-200 text-left
                ${selectedCat === cat._idRow ? "bg-primary/20 text-primary" : ""}`}
            >
              {cat._sIconUrl ? (
                <img
                  src={cat._sIconUrl}
                  alt=""
                  className="w-5 h-5 object-contain flex-shrink-0"
                />
              ) : (
                <span className="w-5 h-5 flex-shrink-0" />
              )}
              {cat._sName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BrowseMods({ modsDir, addLog, onInstall }) {
  const [mods, setMods] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [downloading, setDownloading] = useState(null);
  const [categories, setCategories] = useState([]);
  const [selectedCat, setSelectedCat] = useState(null);
  const [filePickerMod, setFilePickerMod] = useState(null);
  const [viewModal, setViewModal] = useState(null);
  const [perPage, setPerPage] = useState(15);

  const [sortBy, setSortBy] = useState("_tsDateUpdated,DESC");

  const GAME_ID = 7692;
  const PER_PAGE = perPage;
  const CYOP_IDS = [25679, 22962, 25680];
  const GMLOADER_ID = 36921;

  useEffect(() => {
    const fetchCats = async () => {
      try {
        const res = await fetch(
          `https://gamebanana.com/apiv6/ModCategory/ByGame?_aGameRowIds[]=${GAME_ID}&_csvProperties=_sName,_idRow,_sIconUrl,_idParentCategoryRow&_nPerpage=50`,
        );
        const data = await res.json();
        const roots = data.filter((c) => c._idParentCategoryRow === 0);
        setCategories([
          { _idRow: null, _sName: "All", _sIconUrl: null },
          ...roots,
        ]);
      } catch (e) {
        addLog(`Error fetching categories: ${e}`);
      }
    };
    fetchCats();
  }, []);

  // Normalise un mod v6 + v11 en objet unifié
  const normalizeMod = (modV6, modV11 = {}) => {
    const id = modV6._idRow || modV6._sProfileUrl?.split("/").pop();
    return {
      _idRow: id,
      name: modV6._sName,
      owner: modV6._aSubmitter?._sName,
      avi: modV6._aSubmitter?._sAvatarUrl,
      upic: modV6._aSubmitter?._sUpicUrl,
      preview: modV11._aPreviewMedia?._aImages?.[0]
        ? `${modV11._aPreviewMedia._aImages[0]._sBaseUrl}/${modV11._aPreviewMedia._aImages[0]._sFile220 ?? modV11._aPreviewMedia._aImages[0]._sFile}`
        : Array.isArray(modV6._aPreviewMedia) && modV6._aPreviewMedia[0]
          ? `${modV6._aPreviewMedia[0]._sBaseUrl}/${modV6._aPreviewMedia[0]._sFile220 ?? modV6._aPreviewMedia[0]._sFile}`
          : null,
      cat: modV6._aRootCategory?._sName,
      caticon: modV6._aRootCategory?._sIconUrl,
      catId: modV6._aRootCategory?._idRow,
      url: modV6._sProfileUrl || modV11._sProfileUrl,
      lastupdate: modV6._tsDateUpdated || modV11._tsDateModified,
      files: modV6._aFiles || {},
      description: modV6._sDescription || "",
    };
  };

  const fetchMods = async (
    search = "",
    p = 1,
    catId = selectedCat,
    sort = sortBy,
  ) => {
    setLoading(true);
    try {
      if (search) {
        let urlV6 = `https://gamebanana.com/apiv6/Mod/ByName?_sName=*${encodeURIComponent(search)}*&_idGameRow=${GAME_ID}`;
        urlV6 += `&_csvProperties=_sName,_idRow,_sProfileUrl,_aSubmitter,_tsDateUpdated,_aPreviewMedia,_sDescription,_aRootCategory,_aFiles`;
        urlV6 += `&_nPerpage=${PER_PAGE}&_nPage=${p}`;

        const countUrl = `https://gamebanana.com/apiv11/Mod/Index?_nPage=1&_nPerpage=1&_aFilters%5BGeneric_Game%5D=${GAME_ID}&_sName=${encodeURIComponent(search)}`;

        const [resV6, countRes] = await Promise.all([
          fetch(urlV6),
          fetch(countUrl),
        ]);
        const recordsV6 = await resV6.json();
        const countData = await countRes.json();

        const ids = (recordsV6 || []).map(
          (mod) => mod._idRow || mod._sProfileUrl?.split("/").pop(),
        );
        const v11Map = {};
        if (ids.length > 0) {
          const v11Results = await Promise.all(
            ids.map((id) =>
              fetch(
                `https://gamebanana.com/apiv11/Mod/${id}?_csvProperties=_aPreviewMedia,_sProfileUrl,_tsDateModified`,
              ).then((r) => r.json()),
            ),
          );
          ids.forEach((id, i) => {
            v11Map[id] = v11Results[i];
          });
        }

        setTotalCount(
          Math.ceil((countData._aMetadata?._nRecordCount || 0) / PER_PAGE),
        );
        setMods(
          (recordsV6 || []).map((mod) => {
            const id = mod._idRow || mod._sProfileUrl?.split("/").pop();
            return normalizeMod(mod, v11Map[id] || {});
          }),
        );
      } else if (catId) {
        const urlV11 = `https://gamebanana.com/apiv11/Mod/Index?_nPage=${p}&_nPerpage=${PER_PAGE}&_aFilters%5BGeneric_Game%5D=${GAME_ID}&_aFilters%5BGeneric_Category%5D=${catId}&_sOrderBy=${sort}`;
        const countUrl = `https://gamebanana.com/apiv11/Mod/Index?_nPage=1&_nPerpage=1&_aFilters%5BGeneric_Game%5D=${GAME_ID}&_aFilters%5BGeneric_Category%5D=${catId}`;

        const [resV11, countRes] = await Promise.all([
          fetch(urlV11),
          fetch(countUrl),
        ]);
        const recordsV11 = await resV11.json();
        const countData = await countRes.json();

        setTotalCount(
          Math.ceil((countData._aMetadata?._nRecordCount || 0) / PER_PAGE),
        );
        setMods(
          (recordsV11._aRecords || []).map((mod) => normalizeMod(mod, mod)),
        );
      } else {
        let urlV6 = `https://gamebanana.com/apiv6/Mod/ByGame?_aGameRowIds[]=${GAME_ID}`;
        urlV6 += `&_csvProperties=_sName,_idRow,_sProfileUrl,_aSubmitter,_tsDateUpdated,_aPreviewMedia,_aRootCategory`;
        urlV6 += `&_nPerpage=${PER_PAGE}&_nPage=${p}&_sOrderBy=${sort}`;

        const urlV11 = `https://gamebanana.com/apiv11/Mod/Index?_nPage=${p}&_nPerpage=${PER_PAGE}&_aFilters%5BGeneric_Game%5D=${GAME_ID}`;
        const countUrl = `https://gamebanana.com/apiv11/Mod/Index?_nPage=1&_nPerpage=1&_aFilters%5BGeneric_Game%5D=${GAME_ID}`;

        const [resV6, resV11, countRes] = await Promise.all([
          fetch(urlV6),
          fetch(urlV11),
          fetch(countUrl),
        ]);
        const recordsV6 = await resV6.json();
        const recordsV11 = await resV11.json();
        const countData = await countRes.json();

        const v11Map = {};
        for (const mod of recordsV11._aRecords || []) {
          v11Map[mod._idRow] = mod;
        }

        setTotalCount(
          Math.ceil((countData._aMetadata?._nRecordCount || 0) / PER_PAGE),
        );
        setMods(
          (recordsV6 || []).map((mod) => {
            const id = mod._idRow || mod._sProfileUrl?.split("/").pop();
            return normalizeMod(mod, v11Map[id] || {});
          }),
        );
      }
    } catch (e) {
      addLog(`Error fetching mods: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMods(searchTerm, page);
  }, [page]);

  const handleSearch = () => {
    setPage(1);
    fetchMods(searchTerm, 1);
  };

  const handleCatSelect = (catId) => {
    setSelectedCat(catId);
    setPage(1);
    setSearchTerm("");
    fetchMods("", 1, catId);
  };

  const handlePickFile = async (mod) => {
    try {
      const res = await fetch(
        `https://gamebanana.com/apiv11/Mod/${mod._idRow}?_csvProperties=_aFiles,_sDescription,_aRootCategory`,
      );
      const data = await res.json();
      const files = data._aFiles || {};

      if (Object.keys(files).length === 0) {
        addLog(`No files for ${mod.name}`);
        return;
      }

      setFilePickerMod({
        mod,
        files: Object.values(files),
        description: data._sDescription || "",
        rootCatId: data._aRootCategory?._idRow,
        rootCatParentId: data._aRootCategory?._idParentCategoryRow,
      });
    } catch (e) {
      addLog(`Error fetching files: ${e}`);
    }
  };

  const handleDownload = async (file) => {
    const { mod } = filePickerMod;
    setFilePickerMod(null);
    await onInstall(mod._idRow, mod.name, file._idRow, filePickerMod);
  };

  const handleViewMod = async (mod) => {
    try {
      const res = await fetch(
        `https://gamebanana.com/apiv11/Mod/${mod._idRow}?_csvProperties=_sName,_sDescription,_aPreviewMedia,_aSubmitter,_aRootCategory,_tsDateModified,_nDownloadCount,_nLikeCount`,
      );
      const data = await res.json();

      const images =
        data._aPreviewMedia?._aImages?.map(
          (img) => `${img._sBaseUrl}/${img._sFile}`,
        ) || [];

      setViewModal({
        name: data._sName,
        description: data._sDescription,
        author: data._aSubmitter?._sName,
        avi: data._aSubmitter?._sAvatarUrl,
        category: data._aRootCategory?._sName,
        catIcon: data._aRootCategory?._sIconUrl,
        images,
        downloads: data._nDownloadCount,
        likes: data._nLikeCount,
        date: data._tsDateModified,
        url: mod.url,
        raw: mod, // pour install direct
      });
    } catch (e) {
      addLog(`Error loading mod details: ${e}`);
    }
  };

  const handleViewPage = async () => {
    openUrl(viewModal.url);
  };

  return (
    <>
      <div className="flex flex-col h-full gap-3">
        <div className="flex gap-2 flex-shrink-0">
          <input
            type="text"
            placeholder="Search mods on GameBanana..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="input input-bordered input-sm flex-1"
          />
          <CatDropdown
            categories={categories}
            selectedCat={selectedCat}
            onSelect={handleCatSelect}
          />
          <select
            value={sortBy}
            disabled={!!searchTerm || selectedCat}
            onChange={(e) => {
              setSortBy(e.target.value);
              setPage(1);
              fetchMods("", 1, selectedCat, e.target.value);
            }}
            className="select select-bordered select-sm w-auto disabled:opacity-50"
          >
            <option value="_tsDateUpdated,DESC">Latest</option>
            <option value="_nDownloadCount,DESC">Most Downloaded</option>
            <option value="_nLikeCount,DESC">Most Liked</option>
            <option value="_bIsFeatured,DESC">Featured</option>
            <option value="_tsDateUpdated,ASC">Oldest</option>
          </select>
          <button onClick={handleSearch} className="btn btn-sm btn-primary">
            Search
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {loading && <p className="text-sm">Loading...</p>}
          {!loading && mods.length === 0 && (
            <p className="text-sm">No mods found.</p>
          )}
          {!loading && mods.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {mods.map((mod) => (
                <div
                  key={mod._idRow}
                  className="rounded border border-base-300 shadow-md overflow-hidden flex flex-col"
                >
                  {mod.preview && (
                    <img
                      src={mod.preview}
                      alt={mod.name}
                      className="w-full h-32 object-cover"
                      onError={(e) => (e.target.style.display = "none")}
                    />
                  )}
                  <div className="p-3 flex flex-col gap-1 flex-1">
                    <h2 className="text-sm font-bold truncate">{mod.name}</h2>
                    <p className="text-xs text-gray-400 truncate">
                      {mod.owner} • {mod.cat}
                    </p>
                    <div className="mt-auto flex gap-2 pt-2">
                      <button
                        onClick={() => handleViewMod(mod)}
                        className="btn btn-xs btn-outline flex-1"
                      >
                        View
                      </button>
                      <button
                        onClick={() => handlePickFile(mod)}
                        disabled={downloading !== null}
                        className="btn btn-xs btn-primary flex-1"
                      >
                        {downloading === mod._idRow ? "..." : "Install"}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {totalCount > 1 && (
          <div className="grid grid-cols-3 items-center w-full flex-shrink-0">
            <div />

            <div className="flex justify-center">
              <div className="join">
                <button
                  className="join-item btn"
                  disabled={page === 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  ←
                </button>

                <span className="join-item btn btn-active">
                  Page {page} / {totalCount}
                </span>

                <button
                  className="join-item btn"
                  disabled={page >= totalCount}
                  onClick={() => setPage((p) => p + 1)}
                >
                  →
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                className="btn btn-xs btn-outline h-8 min-h-8 px-2"
                onClick={() => fetchMods(searchTerm, page)}
              >
                Refresh
              </button>

              <select
                className="select select-xs select-bordered w-16 h-8 min-h-8 px-1"
                value={perPage}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setPerPage(val);
                  setPage(1);
                  fetchMods(searchTerm, 1, selectedCat, sortBy);
                }}
              >
                <option value={10}>10</option>
                <option value={15}>15</option>
                <option value={25}>25</option>
                <option value={50}>50</option>
              </select>
            </div>
          </div>
        )}
      </div>
      {filePickerMod && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-base-100 rounded-box shadow-xl p-5 w-96 max-h-[80vh] flex flex-col gap-3">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-sm">{filePickerMod.mod.name}</h3>
              <button
                className="btn btn-xs btn-ghost"
                onClick={() => setFilePickerMod(null)}
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-base-content/60">
              Select a version to install:
            </p>
            <div className="flex flex-col gap-2 overflow-y-auto">
              {filePickerMod.files.map((file, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between border border-base-300 rounded p-2 gap-2"
                >
                  <div className="flex flex-col min-w-0">
                    <span className="text-xs font-medium truncate">
                      {file._sFile}
                    </span>
                    {file._sDescription && (
                      <span className="text-xs text-base-content/50 truncate">
                        {file._sDescription}
                      </span>
                    )}
                    <span className="text-xs text-base-content/40">
                      {(file._nFilesize / 1024).toFixed(1)} KB
                    </span>
                  </div>
                  <button
                    onClick={() => handleDownload(file)}
                    className="btn btn-xs btn-primary flex-shrink-0"
                  >
                    Install
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {viewModal && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex justify-center items-center"
          onClick={() => setViewModal(null)}
        >
          <div
            className="bg-base-100 w-[900px] h-[85vh] rounded-box shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative h-56">
              {viewModal.images?.[0] && (
                <img
                  src={viewModal.images[0]}
                  className="w-full h-full object-cover"
                />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
              <div className="absolute bottom-4 left-4 right-4 flex justify-between items-end">
                <div>
                  <h1 className="text-white text-2xl font-bold">
                    {viewModal.name}
                  </h1>
                  <p className="text-white/70 text-sm">by {viewModal.author}</p>
                </div>

                <button
                  className="btn btn-sm btn-circle btn-ghost text-white"
                  onClick={() => setViewModal(null)}
                >
                  ✕
                </button>
              </div>
            </div>

            <div className="flex flex-1 overflow-hidden">
              <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
                {viewModal.images?.length > 0 && (
                  <div className="relative">
                    <div className="carousel w-full rounded-box">
                      {viewModal.images.map((img, i) => (
                        <div
                          key={i}
                          id={`slide-${i}`}
                          className="carousel-item relative w-full"
                        >
                          <img src={img} className="w-full h-80 object-cover" />
                          <div className="absolute flex justify-between transform -translate-y-1/2 left-2 right-2 top-1/2 pointer-events-none">
                            <a
                              href={`#slide-${(i - 1 + viewModal.images.length) % viewModal.images.length}`}
                              className="btn btn-circle btn-sm pointer-events-auto"
                            >
                              ❮
                            </a>
                            <a
                              href={`#slide-${(i + 1) % viewModal.images.length}`}
                              className="btn btn-circle btn-sm pointer-events-auto"
                            >
                              ❯
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <h2 className="font-bold text-lg mb-2">Description</h2>
                  <div
                    className="prose max-w-none text-sm"
                    dangerouslySetInnerHTML={{ __html: viewModal.description }}
                  />
                </div>
              </div>
              <div className="w-64 border-l border-base-300 p-4 flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  {viewModal.avi && (
                    <img
                      src={viewModal.avi}
                      className="w-10 h-10 rounded-full"
                    />
                  )}
                  <div>
                    <p className="text-sm font-medium">{viewModal.author}</p>
                    <p className="text-xs text-base-content/50">Creator</p>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between text-sm">
                    <span>Downloads</span>
                    <span>{viewModal.downloads}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span>Likes</span>
                    <span>{viewModal.likes}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span>Updated</span>
                    <span>
                      {new Date(viewModal.date * 1000).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  {viewModal.catIcon && (
                    <img src={viewModal.catIcon} className="w-5 h-5" />
                  )}
                  <span>{viewModal.category}</span>
                </div>
                <div className="mt-auto flex flex-col gap-2">
                  <button
                    rel="noopener noreferrer"
                    className="btn btn-sm btn-outline"
                    onClick={handleViewPage}
                  >
                    View Page
                  </button>

                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => {
                      setViewModal(null);
                      handlePickFile(viewModal.raw);
                    }}
                  >
                    Install
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
export default BrowseMods;
