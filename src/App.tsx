import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UploadCloud, File as FileIcon, Folder, FolderPlus, Trash2, Download, HardDrive, Code, Loader2, Share2, Lock, ChevronRight, Settings } from 'lucide-react';
import { format } from 'date-fns';
import { cn, formatBytes } from './lib/utils';
import { CHUNK_SIZE, deriveKey, encryptChunk, decryptChunk, bufToBase64, base64ToBuf } from './lib/crypto';

type ViewMode = 'drive' | 'code' | 'share';
type FileData = { id: string; name: string; type: 'file' | 'folder'; parent_id: string | null; size: number; total_chunks: number; uploaded_at: string; salt: string; chunk_prefix: string; storage_backend: string; };

export default function App() {
  const pathname = window.location.pathname;
  const match = pathname.match(/^\/share\/([^\/]+)/);
  const initialSharedId = match ? match[1] : null;

  const [view, setView] = useState<ViewMode>(initialSharedId ? 'share' : 'drive');
  const [allItems, setAllItems] = useState<FileData[]>([]);
  const [resolvedFolders, setResolvedFolders] = useState<Set<string | null>>(new Set());
  
  const [sharedFile, setSharedFile] = useState<FileData | null>(null);
  const [loading, setLoading] = useState(true);
  
  const [activeTask, setActiveTask] = useState<{ type: 'upload' | 'download', filename: string, progress: number } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // File Tree State
  const [history, setHistory] = useState<{id: string | null, name: string}[]>([{ id: null, name: 'My Drive' }]);
  const currentFolderId = history[history.length - 1].id;
  
  // R2 Public URL Settings
  const [r2PublicUrl, setR2PublicUrl] = useState<string>(localStorage.getItem('PUBLIC_R2_URL') || '');

  useEffect(() => {
    if (initialSharedId) {
      fetchSharedFile(initialSharedId);
    } else {
      fetchItems(currentFolderId);
    }
  }, [currentFolderId]);

  const currentItems = allItems.filter(f => f.parent_id === currentFolderId);

  const fetchSharedFile = async (id: string) => {
    try {
      const res = await fetch(`/api/files/${id}`);
      if (res.ok) {
        const data = await res.json();
        setSharedFile(data);
      } else {
        setSharedFile(null);
      }
    } catch (e) {
      console.error("Failed to fetch shared file", e);
    } finally {
      setLoading(false);
    }
  };

  const fetchItems = async (parentId: string | null, force = false) => {
    if (!force && resolvedFolders.has(parentId)) {
        return; // Cache Hit! Tree up to here is already loaded completely
    }
    
    setLoading(true);
    try {
      const url = parentId ? `/api/files?parent=${parentId}` : '/api/files';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        
        setAllItems(prev => {
            const incomingIds = new Set(data.items.map((i: any) => i.id));
            const filtered = prev.filter(i => !incomingIds.has(i.id));
            return [...filtered, ...data.items];
        });
        
        setResolvedFolders(prev => {
            const next = new Set(prev);
            data.resolvedParents.forEach((p: string | null) => next.add(p));
            return next;
        });
      }
    } catch (e) {
      console.error("Failed to fetch items", e);
    } finally {
      setLoading(false);
    }
  };

  const goHome = () => {
    window.history.replaceState({}, '', '/');
    setView('drive');
    setHistory([{ id: null, name: 'My Drive' }]);
  };

  const navigateTo = (folder: FileData) => {
    setHistory([...history, { id: folder.id, name: folder.name }]);
  };

  const navigateUpTo = (index: number) => {
    setHistory(history.slice(0, index + 1));
  };

  const createFolder = async () => {
      const name = prompt("Enter folder name:");
      if (!name) return;
      try {
         await fetch('/api/files', {
             method: 'POST',
             body: JSON.stringify({ name, type: 'folder', parentId: currentFolderId }),
             headers: { 'Content-Type': 'application/json' }
         });
         setResolvedFolders(new Set()); // Flush local cache
         fetchItems(currentFolderId, true);
      } catch(e) {
         alert("Failed to create folder");
      }
  };

  const deleteItem = async (id: string, name: string, type: 'file' | 'folder') => {
    const msg = type === 'folder' 
       ? `Delete folder "${name}" AND all its contents recursively?`
       : `Are you sure you want to delete "${name}"?`;
    if (!confirm(msg)) return;
    
    try {
      await fetch(`/api/files/${id}`, { method: 'DELETE' });
      setResolvedFolders(new Set()); // Flush local cache
      fetchItems(currentFolderId, true);
    } catch (e) {
      console.error("Failed to delete", e);
    }
  };

  const shareFile = (id: string) => {
    const shareUrl = `${window.location.origin}/share/${id}`;
    navigator.clipboard.writeText(shareUrl);
    alert('Share link copied! Users can decrypt with your password.');
  };

  const uploadFile = async (file: File) => {
    const password = prompt(`Enter a password to encrypt ${file.name}:`);
    if (!password) return;
    
    setActiveTask({ type: 'upload', filename: file.name, progress: 0 });
    
    try {
      const fileId = crypto.randomUUID();
      // Obfuscated long prefix for chunk keys to blindly direct public R2 downloads
      const chunkPrefix = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const saltB64 = bufToBase64(salt.buffer);
      const limitSize = 1.2 * 1024 * 1024; // 1.2MB D1 safe threshold
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
      const storageBackend = file.size <= limitSize ? 'D1' : 'KV';
      
      const res = await fetch('/api/files', {
         method: 'POST',
         body: JSON.stringify({ 
             id: fileId, name: file.name, type: 'file', parentId: currentFolderId, 
             size: file.size, totalChunks, salt: saltB64, chunkPrefix, storageBackend
         }),
         headers: { 'Content-Type': 'application/json' }
      });
      if (!res.ok) throw new Error("Failed to initialize file metadata in D1");

      const key = await deriveKey(password, salt.buffer);

      for (let i = 0; i < totalChunks; i++) {
         const start = i * CHUNK_SIZE;
         const end = Math.min(start + CHUNK_SIZE, file.size);
         const slice = file.slice(start, end);
         const plainChunk = await slice.arrayBuffer();
         const cipherChunk = await encryptChunk(plainChunk, key);
         
         const chunkRes = await fetch(`/api/inodes?prefix=${chunkPrefix}&index=${i}&backend=${storageBackend}`, {
             method: 'PUT',
             body: cipherChunk
         });
         if (!chunkRes.ok) throw new Error(`Failed to put chunk ${i} to ${storageBackend}`);
         
         setActiveTask({ type: 'upload', filename: file.name, progress: Math.round(((i + 1) / totalChunks) * 100) });
      }

      setResolvedFolders(new Set()); // Flush local cache
      fetchItems(currentFolderId, true);
    } catch (e) {
      alert("Upload failed. " + (e as Error).message);
    } finally {
      setActiveTask(null);
    }
  };

  const downloadFile = async (f: FileData) => {
    if (!('showSaveFilePicker' in window) && f.size > 250 * 1024 * 1024) {
        if (!confirm(`⚠️ Warning: No direct-disk writing.\nDownloading ${formatBytes(f.size)} will cache in RAM. Proceed?`)) return;
    }

    const password = prompt(`Enter the password to decrypt ${f.name}:`);
    if (!password) return;
    
    setActiveTask({ type: 'download', filename: f.name, progress: 0 });
    
    try {
      const key = await deriveKey(password, base64ToBuf(f.salt));
      let writableStream: any = null;
      
      if ('showSaveFilePicker' in window) {
         try {
             const fileHandle = await (window as any).showSaveFilePicker({ suggestedName: f.name });
             writableStream = await fileHandle.createWritable();
         } catch (e) { setActiveTask(null); return; }
      }
      
      const blobs: Blob[] = [];
      
      for (let i = 0; i < f.total_chunks; i++) {
          const chunkUrl = `/api/inodes?prefix=${f.chunk_prefix}&index=${i}&backend=${f.storage_backend}`;
                
          const res = await fetch(chunkUrl);
          if (!res.ok) throw new Error(`Chunk fetch failed.`);
          
          const encryptedBuf = await res.arrayBuffer();
          try {
             const decryptedBuf = await decryptChunk(encryptedBuf, key);
             if (writableStream) await writableStream.write(decryptedBuf);
             else blobs.push(new Blob([decryptedBuf]));
          } catch(e) { throw new Error("Decryption failed! Incorrect password."); }
          
          setActiveTask({ type: 'download', filename: f.name, progress: Math.round(((i + 1) / f.total_chunks) * 100) });
      }
      
      if (writableStream) {
          await writableStream.close();
      } else {
          const mergedBlob = new Blob(blobs);
          const link = document.createElement('a');
          link.href = URL.createObjectURL(mergedBlob);
          link.download = f.name;
          link.click();
          URL.revokeObjectURL(link.href);
      }
    } catch(e) {
        alert((e as Error).message);
    } finally {
        setActiveTask(null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (!activeTask && e.dataTransfer.files && e.dataTransfer.files[0]) {
      uploadFile(e.dataTransfer.files[0]);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-100 flex flex-col font-sans text-neutral-900">
      <header className="bg-white border-b border-neutral-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-3 cursor-pointer" onClick={goHome}>
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center text-white shadow-sm">
            <CloudflareIcon className="w-6 h-6" />
          </div>
          <div>
            <h1 className="font-semibold text-lg leading-tight">Secure Web Drive</h1>
            <p className="text-xs text-neutral-500">Zero Trust • Direct CDN Link</p>
          </div>
        </div>
        
                 <div className="flex bg-neutral-100 p-1 rounded-lg border border-neutral-200 mt-4 sm:mt-0">
          <button onClick={goHome} className={cn("flex items-center gap-2 px-4 py-1.5 text-sm font-medium rounded-md transition-colors", view === 'drive' ? "bg-white shadow-sm text-neutral-900" : "text-neutral-500 hover:text-neutral-700")}>
            <HardDrive className="w-4 h-4" /> My Drive
          </button>
          <button onClick={() => setView('code')} className={cn("flex items-center gap-2 px-4 py-1.5 text-sm font-medium rounded-md transition-colors", view === 'code' ? "bg-white shadow-sm text-neutral-900" : "text-neutral-500 hover:text-neutral-700")}>
            <Code className="w-4 h-4" /> Setup
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto p-4 md:p-8">
        <AnimatePresence mode="wait">
          {view === 'share' ? (
            <motion.div key="share" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="max-w-xl mx-auto mt-12">
               <div className="bg-white border border-neutral-200 rounded-2xl p-8 text-center shadow-sm">
                  <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-6"><Lock className="w-8 h-8" /></div>
                  {loading ? (
                     <Loader2 className="w-8 h-8 text-indigo-600 animate-spin mx-auto" />
                  ) : sharedFile && sharedFile.type === 'file' ? (
                     <>
                        <h2 className="text-2xl font-bold text-neutral-900 mb-2">Secure Shared File</h2>
                        <p className="text-neutral-500 mb-8 max-w-sm mx-auto text-sm">Download directly from Cloudflare Global Edge. You need the AES password from the sender.</p>
                        
                        <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-4 flex items-center gap-4 text-left mb-8">
                           <div className="w-10 h-10 rounded-lg bg-white border border-neutral-200 flex items-center justify-center flex-shrink-0 text-neutral-500">
                               <FileIcon className="w-5 h-5" />
                           </div>
                           <div className="truncate">
                              <p className="font-semibold text-sm text-neutral-900 truncate">{sharedFile.name}</p>
                              <p className="text-xs text-neutral-500 mt-0.5">{formatBytes(sharedFile.size)} • {sharedFile.total_chunks} chunk(s)</p>
                           </div>
                        </div>

                        {activeTask ? (
                          <div className="w-full">
                              <Loader2 className="w-8 h-8 text-indigo-600 animate-spin mb-4 mx-auto" />
                              <div className="w-full bg-neutral-200 rounded-full h-2.5 overflow-hidden">
                                <div className="bg-indigo-600 h-2.5 rounded-full transition-all duration-300" style={{ width: `${activeTask.progress}%` }}></div>
                              </div>
                              <p className="text-xs font-semibold text-neutral-600 mt-2">{activeTask.progress}%</p>
                          </div>
                        ) : (
                          <button onClick={() => downloadFile(sharedFile)} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 rounded-xl transition-colors flex items-center justify-center gap-2">
                             <Download className="w-5 h-5" /> Decrypt & Download
                          </button>
                        )}
                     </>
                  ) : (
                     <div className="text-center text-neutral-500 py-8">
                        <FileIcon className="w-12 h-12 text-neutral-300 mx-auto mb-4" />
                        <p>File not found or format invalid.</p>
                     </div>
                  )}
                  <button onClick={goHome} className="mt-8 text-sm text-neutral-500 hover:text-neutral-900 font-medium">Return to My Drive</button>
               </div>
            </motion.div>
          ) : view === 'drive' ? (
            <motion.div key="drive" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-6">
              
              <div className="flex items-center justify-between pb-2">
                 <div className="flex items-center gap-2 text-sm font-medium">
                    {history.map((h, i) => (
                       <React.Fragment key={i}>
                         <button onClick={() => navigateUpTo(i)} className={cn("hover:text-indigo-600 transition-colors", i === history.length - 1 ? "text-neutral-900 cursor-default" : "text-neutral-500")}>
                           {h.name}
                         </button>
                         {i < history.length - 1 && <ChevronRight className="w-4 h-4 text-neutral-400" />}
                       </React.Fragment>
                    ))}
                 </div>
                 <button onClick={createFolder} className="flex items-center gap-2 text-sm text-indigo-600 font-medium hover:text-indigo-700 bg-indigo-50 px-3 py-1.5 rounded-lg border border-indigo-100">
                    <FolderPlus className="w-4 h-4" /> New Folder
                 </button>
              </div>

              <div onDragOver={(e) => { e.preventDefault(); setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDrop={handleDrop} className={cn("border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-center transition-all bg-white", dragActive ? "border-indigo-500 bg-indigo-50" : "border-neutral-300", activeTask?.type === 'upload' && "opacity-50 pointer-events-none")}>
                {activeTask ? (
                  <div className="w-full max-w-sm">
                      <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mb-4 mx-auto" />
                      <h3 className="text-lg font-medium mb-1 capitalize">{activeTask.type}ing...</h3>
                      <div className="w-full bg-neutral-200 rounded-full h-2.5 overflow-hidden"><div className="bg-indigo-600 h-2.5 rounded-full" style={{ width: `${activeTask.progress}%` }}></div></div>
                  </div>
                ) : (
                  <>
                      <UploadCloud className="w-10 h-10 mb-4 text-neutral-400" />
                      <h3 className="text-lg font-medium mb-1">Upload securely to {history[history.length-1].name}</h3>
                      <p className="text-sm text-neutral-500 mb-6 max-w-sm">
                        Files are AES-GCM encrypted locally. Object storage uses KV/D1 dynamically.
                      </p>
                      <input type="file" ref={fileInputRef} className="hidden" onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])} />
                      <button onClick={() => fileInputRef.current?.click()} className="mt-4 bg-neutral-900 hover:bg-neutral-800 text-white px-6 py-2.5 rounded-lg font-medium text-sm">Browse Files</button>
                  </>
                )}
              </div>

              <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden shadow-sm">
                <div className="px-6 py-4 border-b border-neutral-200 bg-neutral-50 flex items-center justify-between">
                  <h2 className="font-semibold text-neutral-800">Contents ({currentItems.length})</h2>
                </div>
                {loading && !resolvedFolders.has(currentFolderId) ? ( <div className="p-12 flex justify-center"><Loader2 className="w-6 h-6 text-neutral-400 animate-spin" /></div>
                ) : currentItems.length === 0 ? ( <div className="p-12 text-center text-neutral-500"><HardDrive className="w-12 h-12 text-neutral-300 mx-auto mb-3" /><p>Empty folder.</p></div>
                ) : (
                  <ul className="divide-y divide-neutral-100">
                    {currentItems.map((item) => (
                      <li key={item.id} className="flex items-center justify-between p-4 hover:bg-neutral-50 transition-colors group">
                        <div className="flex items-center gap-4 overflow-hidden flex-1 cursor-pointer" onClick={() => item.type === 'folder' && navigateTo(item)}>
                          <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 text-white", item.type === 'folder' ? "bg-amber-400" : "bg-neutral-200 text-neutral-600")}>
                            {item.type === 'folder' ? <Folder className="w-5 h-5" /> : <FileIcon className="w-5 h-5" />}
                          </div>
                          <div className="truncate">
                            <p className="font-medium text-sm text-neutral-900 truncate">{item.name}</p>
                            <div className="flex items-center gap-3 text-xs text-neutral-500 mt-0.5">
                              {item.type === 'file' && <span>{formatBytes(item.size)}</span>}
                              {item.type === 'file' && <span className="border border-neutral-300 px-1 py-0.5 rounded text-[10px] tracking-wider text-neutral-500 font-bold bg-white">{item.storage_backend || 'KV'}</span>}
                              {item.type === 'file' && <span>•</span>}
                              <span>{format(new Date(item.uploaded_at), 'MMM d, yyyy')}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          {item.type === 'file' && (
                            <>
                              <button onClick={() => shareFile(item.id)} className="p-2 text-neutral-400 hover:text-blue-600" title="Share"><Share2 className="w-4 h-4" /></button>
                              <button onClick={() => downloadFile(item)} className="p-2 text-neutral-400 hover:text-indigo-600" title="Download"><Download className="w-4 h-4" /></button>
                            </>
                          )}
                          <button onClick={() => deleteItem(item.id, item.name, item.type)} className="p-2 text-neutral-400 hover:text-red-600" title="Delete"><Trash2 className="w-4 h-4" /></button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div key="code" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} className="space-y-8">
              <div className="bg-white border border-neutral-200 p-8 rounded-xl shadow-sm">
                
                <h2 className="text-xl font-bold mb-6 flex items-center gap-2"><Settings className="w-5 h-5" /> Secured Infrastructure Model</h2>
                
                <div className="bg-blue-50 border border-blue-200 p-5 rounded-xl mb-8">
                   <h3 className="font-semibold text-blue-900 mb-2">Simplicity & Cost Security</h3>
                   <p className="text-sm text-blue-800 leading-relaxed">
                     To prevent unexpected billing entirely, we have abandoned R2 and moved object storage to <strong>Cloudflare Workers KV</strong>. KV has strict daily quotas on the free tier (1,000 writes / 100,000 reads) but guarantees no overage charges without a credit card.
                     <br/><br/>
                     By combining this with our chunk prefix obfuscation (where physical chunk names are long UUIDs hidden from everyone), malicious actors cannot guess data URLs. Even if they somehow script the exact URL, CF automatically cuts off traffic once you reach 100k daily KV reads, protecting your wallet absolutely!
                   </p>
                </div>

                <div className="space-y-6 pt-4 border-t border-neutral-100">
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center font-medium text-sm flex-shrink-0">1</div>
                    <div className="flex-1">
                      <h3 className="font-semibold mb-1">Create Workers KV & Bind</h3>
                      <p className="text-neutral-600 text-sm mb-3">Go to your Cloudflare Dashboard and create a Workers KV namespace. Then go to your Pages project <strong>Settings &gt; Functions</strong>, and under <strong>KV namespace bindings</strong>, bind the variable <code className="bg-neutral-100 px-1 py-0.5 rounded border">KV_STORE</code> to your new namespace.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center font-medium text-sm flex-shrink-0">2</div>
                    <div className="flex-1">
                      <h3 className="font-semibold mb-1">Apply DB Schema</h3>
                      <p className="text-neutral-600 text-sm mb-3">Copy the latest <code className="bg-neutral-100 px-1 py-0.5 rounded text-neutral-800 border">schema.sql</code> and execute it in your D1 Console. <br/><br/>
                      <strong className="text-red-600">If updating from prior versions, you MUST run:</strong> <code className="bg-neutral-100 px-1 py-0.5 rounded text-neutral-800 border text-xs block mt-1 leading-relaxed">ALTER TABLE files ADD COLUMN storage_backend TEXT DEFAULT 'KV';</code> to support D1 small-file BLOB storage.</p>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

function CloudflareIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M19.34 9.17c-.3-2.61-2.45-4.67-5.06-4.67-1.46 0-2.82.6-3.8 1.63-1.07-1.28-2.69-2.01-4.4-1.85-2.22.21-3.99 1.95-4.22 4.18C1.19 8.65.64 9.47.33 10.4.08 11.23 0 12.11 0 13c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.52-1.85-4.62-4.66-4.83z" />
    </svg>
  )
}
