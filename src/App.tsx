import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { UploadCloud, File as FileIcon, Trash2, Download, HardDrive, Code, Loader2, Copy, Share2, Lock } from 'lucide-react';
import { format } from 'date-fns';
import { cn, formatBytes } from './lib/utils';
import { CHUNK_SIZE, deriveKey, encryptChunk, decryptChunk, bufToBase64, base64ToBuf } from './lib/crypto';

type ViewMode = 'drive' | 'code' | 'share';
type FileData = { id: string; name: string; size: number; total_chunks: number; uploaded_at: string; salt: string; };

export default function App() {
  const pathname = window.location.pathname;
  const match = pathname.match(/^\/share\/([^\/]+)/);
  const initialSharedId = match ? match[1] : null;

  const [view, setView] = useState<ViewMode>(initialSharedId ? 'share' : 'drive');
  const [files, setFiles] = useState<FileData[]>([]);
  const [sharedFile, setSharedFile] = useState<FileData | null>(null);
  const [loading, setLoading] = useState(true);
  
  const [activeTask, setActiveTask] = useState<{ type: 'upload' | 'download', filename: string, progress: number } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialSharedId) {
      fetchSharedFile(initialSharedId);
    } else {
      fetchFiles();
    }
  }, []);

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

  const fetchFiles = async () => {
    try {
      const res = await fetch('/api/files');
      if (res.ok) {
        const data = await res.json();
        setFiles(data);
      }
    } catch (e) {
      console.error("Failed to fetch files", e);
    } finally {
      setLoading(false);
    }
  };

  const goHome = () => {
    window.history.replaceState({}, '', '/');
    setView('drive');
    if (files.length === 0 && !initialSharedId) {
        setLoading(true);
        fetchFiles();
    } else if (initialSharedId) {
        // If we came from a shared link, we need to fetch files now
        setLoading(true);
        fetchFiles();
    }
  };

  const deleteFile = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete "${name}"?`)) return;
    try {
      await fetch(`/api/files/${id}`, { method: 'DELETE' });
      fetchFiles();
    } catch (e) {
      console.error("Failed to delete file", e);
    }
  };

  const shareFile = (id: string) => {
    const shareUrl = `${window.location.origin}/share/${id}`;
    navigator.clipboard.writeText(shareUrl);
    alert('Share link copied to clipboard!');
  };

  const uploadFile = async (file: File) => {
    const password = prompt(`Enter a password to encrypt ${file.name}:`);
    if (!password) return;
    
    setActiveTask({ type: 'upload', filename: file.name, progress: 0 });
    
    try {
      const fileId = crypto.randomUUID();
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const saltB64 = bufToBase64(salt.buffer);
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
      
      const res = await fetch('/api/files', {
         method: 'POST',
         body: JSON.stringify({ id: fileId, name: file.name, size: file.size, totalChunks, salt: saltB64 }),
         headers: { 'Content-Type': 'application/json' }
      });
      if (!res.ok) throw new Error("Failed to initialize file record");

      const key = await deriveKey(password, salt.buffer);

      for (let i = 0; i < totalChunks; i++) {
         const start = i * CHUNK_SIZE;
         const end = Math.min(start + CHUNK_SIZE, file.size);
         const slice = file.slice(start, end);
         const plainChunk = await slice.arrayBuffer();
         
         const cipherChunk = await encryptChunk(plainChunk, key);
         
         const chunkRes = await fetch(`/api/inodes?fileId=${fileId}&index=${i}`, {
             method: 'PUT',
             body: cipherChunk
         });
         
         if (!chunkRes.ok) throw new Error(`Failed to upload chunk ${i}`);
         
         setActiveTask({ type: 'upload', filename: file.name, progress: Math.round(((i + 1) / totalChunks) * 100) });
      }

      fetchFiles();
    } catch (e) {
      console.error("Upload failed", e);
      alert("Upload failed. " + (e as Error).message);
    } finally {
      setActiveTask(null);
    }
  };

  const downloadFile = async (f: FileData) => {
    // Check if the browser does NOT support experimental Stream Writer
    if (!('showSaveFilePicker' in window)) {
        const MEMORY_WARNING_THRESHOLD = 250 * 1024 * 1024; // 250MB size warning
        if (f.size > MEMORY_WARNING_THRESHOLD) {
           const proceed = confirm(`⚠️ Warning: Your current browser lacks support for direct-to-disk streaming.\n\nDownloading this large file (${formatBytes(f.size)}) will cache it entirely in RAM, which might crash the tab. We strongly recommend Desktop Chrome or Edge for large zero-trust file decryption.\n\nDo you want to proceed anyway?`);
           if (!proceed) return;
        }
    }

    const password = prompt(`Enter the password to decrypt ${f.name}:`);
    if (!password) return;
    
    setActiveTask({ type: 'download', filename: f.name, progress: 0 });
    
    try {
      const key = await deriveKey(password, base64ToBuf(f.salt));
      
      let fileHandle: any = null;
      let writableStream: any = null;
      
      if ('showSaveFilePicker' in window) {
         try {
             fileHandle = await (window as any).showSaveFilePicker({ suggestedName: f.name });
             writableStream = await fileHandle.createWritable();
         } catch (e) {
             console.log("User aborted save picker");
             setActiveTask(null);
             return;
         }
      }
      
      const blobs: Blob[] = [];
      
      for (let i = 0; i < f.total_chunks; i++) {
          const res = await fetch(`/api/inodes?fileId=${f.id}&index=${i}`);
          if (!res.ok) throw new Error(`Failed to download chunk ${i}. Incorrect password or corrupted db?`);
          
          const encryptedBuf = await res.arrayBuffer();
          
          try {
             const decryptedBuf = await decryptChunk(encryptedBuf, key);
             if (writableStream) {
                 await writableStream.write(decryptedBuf);
             } else {
                 blobs.push(new Blob([decryptedBuf]));
             }
          } catch(e) {
             throw new Error("Decryption failed! Incorrect password.");
          }
          
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
        console.error(e);
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
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center text-white shadow-sm">
            <CloudflareIcon className="w-6 h-6" />
          </div>
          <div>
            <h1 className="font-semibold text-lg leading-tight">Secure Web Drive</h1>
            <p className="text-xs text-neutral-500">Client-Side E2E Encrypted</p>
          </div>
        </div>
        
        <div className="flex bg-neutral-100 p-1 rounded-lg border border-neutral-200 mt-4 sm:mt-0">
          <button 
            onClick={goHome}
            className={cn("flex items-center gap-2 px-4 py-1.5 text-sm font-medium rounded-md transition-colors", view === 'drive' ? "bg-white shadow-sm text-neutral-900" : "text-neutral-500 hover:text-neutral-700")}
          >
            <HardDrive className="w-4 h-4" /> My Drive
          </button>
          <button 
            onClick={() => setView('code')}
            className={cn("flex items-center gap-2 px-4 py-1.5 text-sm font-medium rounded-md transition-colors", view === 'code' ? "bg-white shadow-sm text-neutral-900" : "text-neutral-500 hover:text-neutral-700")}
          >
            <Code className="w-4 h-4" /> Setup Guide
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto p-4 md:p-8">
        <AnimatePresence mode="wait">
          {view === 'share' ? (
            <motion.div 
               key="share"
               initial={{ opacity: 0, y: 10 }}
               animate={{ opacity: 1, y: 0 }}
               exit={{ opacity: 0, y: -10 }}
               className="max-w-xl mx-auto mt-12"
            >
               <div className="bg-white border border-neutral-200 rounded-2xl p-8 text-center shadow-sm">
                  <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
                     <Lock className="w-8 h-8" />
                  </div>
                  {loading ? (
                     <Loader2 className="w-8 h-8 text-indigo-600 animate-spin mx-auto" />
                  ) : sharedFile ? (
                     <>
                        <h2 className="text-2xl font-bold text-neutral-900 mb-2">Secure Shared File</h2>
                        <p className="text-neutral-500 mb-8 max-w-sm mx-auto text-sm">This file is End-to-End Encrypted. You need the decryption password from the sender to download it securely.</p>
                        
                        <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-4 flex items-center justify-between text-left mb-8">
                           <div className="flex items-center gap-4 overflow-hidden">
                              <div className="w-10 h-10 rounded-lg bg-white border border-neutral-200 flex items-center justify-center flex-shrink-0 text-neutral-500">
                                 <FileIcon className="w-5 h-5" />
                              </div>
                              <div className="truncate">
                                <p className="font-semibold text-sm text-neutral-900 truncate">{sharedFile.name}</p>
                                <p className="text-xs text-neutral-500 mt-0.5">{formatBytes(sharedFile.size)} • {sharedFile.total_chunks} chunk(s)</p>
                              </div>
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
                          <button 
                             onClick={() => downloadFile(sharedFile)}
                             className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
                          >
                             <Download className="w-5 h-5" /> Decrypt & Download
                          </button>
                        )}
                     </>
                  ) : (
                     <div className="text-center text-neutral-500 py-8">
                        <FileIcon className="w-12 h-12 text-neutral-300 mx-auto mb-4" />
                        <p>File not found or link has expired.</p>
                     </div>
                  )}
                  <button onClick={goHome} className="mt-8 text-sm text-neutral-500 hover:text-neutral-900 font-medium">Return to My Drive</button>
               </div>
            </motion.div>
          ) : view === 'drive' ? (
            <motion.div 
              key="drive"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <div 
                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                className={cn(
                  "border-2 border-dashed rounded-xl p-10 flex flex-col items-center justify-center text-center transition-all duration-200 bg-white",
                  dragActive ? "border-indigo-500 bg-indigo-50/50 scale-[1.02]" : "border-neutral-300 hover:border-neutral-400",
                  activeTask?.type === 'upload' && "opacity-50 pointer-events-none"
                )}
              >
                {activeTask ? (
                  <div className="w-full max-w-sm">
                      <Loader2 className="w-10 h-10 text-indigo-600 animate-spin mb-4 mx-auto" />
                      <h3 className="text-lg font-medium mb-1 capitalize">{activeTask.type}ing...</h3>
                      <p className="text-sm text-neutral-500 mb-3 truncate">{activeTask.filename}</p>
                      <div className="w-full bg-neutral-200 rounded-full h-2.5 overflow-hidden">
                        <div className="bg-indigo-600 h-2.5 rounded-full transition-all duration-300" style={{ width: `${activeTask.progress}%` }}></div>
                      </div>
                      <p className="text-xs font-semibold text-neutral-600 mt-2">{activeTask.progress}%</p>
                  </div>
                ) : (
                  <>
                      <UploadCloud className={cn("w-10 h-10 mb-4", dragActive ? "text-indigo-500" : "text-neutral-400")} />
                      <h3 className="text-lg font-medium mb-1">Drag & Drop secure files here</h3>
                      <p className="text-sm text-neutral-500 mb-6 max-w-sm">
                        Files are chunked and AES-GCM encrypted in your browser before transmission.
                      </p>
                      <input 
                        type="file" 
                        ref={fileInputRef} 
                        className="hidden" 
                        onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])}
                      />
                      <button 
                        onClick={() => fileInputRef.current?.click()}
                        disabled={!!activeTask}
                        className="bg-neutral-900 hover:bg-neutral-800 text-white px-6 py-2.5 rounded-lg font-medium text-sm transition-colors"
                      >
                        Browse Files
                      </button>
                  </>
                )}
              </div>

              <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden shadow-sm">
                <div className="px-6 py-4 border-b border-neutral-200 bg-neutral-50">
                  <h2 className="font-semibold text-neutral-800">Files ({files.length})</h2>
                </div>
                {loading ? (
                  <div className="p-12 flex justify-center">
                    <Loader2 className="w-6 h-6 text-neutral-400 animate-spin" />
                  </div>
                ) : files.length === 0 ? (
                  <div className="p-12 text-center text-neutral-500 flex flex-col items-center">
                    <HardDrive className="w-12 h-12 text-neutral-300 mb-3" />
                    <p>No files uploaded yet.</p>
                  </div>
                ) : (
                  <ul className="divide-y divide-neutral-100">
                    {files.map((f) => (
                      <li key={f.id} className="flex items-center justify-between p-4 hover:bg-neutral-50 transition-colors group">
                        <div className="flex items-center gap-4 overflow-hidden">
                          <div className="w-10 h-10 rounded-lg bg-neutral-100 flex items-center justify-center flex-shrink-0 text-neutral-500">
                            <FileIcon className="w-5 h-5" />
                          </div>
                          <div className="truncate">
                            <p className="font-medium text-sm text-neutral-900 truncate">{f.name}</p>
                            <div className="flex items-center gap-3 text-xs text-neutral-500 mt-0.5">
                              <span>{formatBytes(f.size)}</span>
                              <span>•</span>
                              <span>{format(new Date(f.uploaded_at), 'MMM d, yyyy HH:mm')}</span>
                              <span>•</span>
                              <span>{f.total_chunks} chunks</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button 
                            onClick={() => shareFile(f.id)}
                            disabled={!!activeTask}
                            className="p-2 text-neutral-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
                            title="Copy Share Link"
                          >
                            <Share2 className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => downloadFile(f)}
                            disabled={!!activeTask}
                            className="p-2 text-neutral-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors"
                            title="Download & Decrypt"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={() => deleteFile(f.id, f.name)}
                            disabled={!!activeTask}
                            className="p-2 text-neutral-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div 
              key="code"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-8"
            >
              <div className="bg-white border border-neutral-200 p-8 rounded-xl shadow-sm">
                <div className="mb-6">
                  <h2 className="text-xl font-semibold mb-2 flex items-center gap-2">
                     Deploying E2E Encrypted Drive
                  </h2>
                  <p className="text-neutral-600 leading-relaxed">
                    This drive uses <strong>Cloudflare R2</strong> for chunk object storage, and <strong>Cloudflare D1</strong> (SQLite) to maintain the filesystem relations. Everything is encrypted using Web Crypto AES-GCM in the browser before transmission.
                  </p>
                </div>

                <div className="space-y-6">
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-neutral-100 border border-neutral-200 flex items-center justify-center font-medium text-sm flex-shrink-0">1</div>
                    <div className="flex-1">
                      <h3 className="font-semibold mb-1">Create R2 & D1 from the Dashboard</h3>
                      <p className="text-neutral-600 text-sm mb-3">Go to your Cloudflare Dashboard. Create an R2 bucket (e.g. <code className="bg-neutral-100 px-1 py-0.5 rounded text-neutral-800 border">simple-drive-bucket</code>) and a D1 database (e.g. <code className="bg-neutral-100 px-1 py-0.5 rounded text-neutral-800 border">simple-drive-db</code>) via the UI menus.</p>
                    </div>
                  </div>
                  
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-neutral-100 border border-neutral-200 flex items-center justify-center font-medium text-sm flex-shrink-0">2</div>
                    <div className="flex-1 overflow-hidden">
                      <h3 className="font-semibold mb-1">Apply DB Schema via Console</h3>
                      <p className="text-neutral-600 text-sm mb-3">Open your newly created D1 database in the Cloudflare Dashboard, go to the <strong>Console</strong> tab, copy the contents of the <code className="bg-neutral-100 px-1 py-0.5 rounded text-neutral-800 border">schema.sql</code> file from this repo, and execute it to create the tables.</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full bg-neutral-100 border border-neutral-200 flex items-center justify-center font-medium text-sm flex-shrink-0">3</div>
                    <div className="flex-1 overflow-hidden">
                      <h3 className="font-semibold mb-1">Deploy & Bind in Settings</h3>
                      <p className="text-neutral-600 text-sm mb-3">
                         Push this repo to GitHub and connect it to a Cloudflare Pages project. 
                         Once created, go to <strong>Settings &gt; Functions</strong>. Under <strong>D1 database bindings</strong>, add variable <code className="bg-neutral-100 px-1 py-0.5 rounded text-neutral-800 border">DB</code> mapped to your database. Under <strong>R2 bucket bindings</strong>, add variable <code className="bg-neutral-100 px-1 py-0.5 rounded text-neutral-800 border">MY_BUCKET</code> mapped to your bucket.
                      </p>
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
