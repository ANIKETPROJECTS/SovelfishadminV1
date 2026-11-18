import { useCallback, useEffect, useRef, useState } from "react";
import { FolderCog, HardDrive, ImagePlus, Pencil, RefreshCw, Trash2, Upload, Video } from "lucide-react";
import { apiFetch, getCurrentAdminScope } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type BannerThumbnail = { name: string; size: number; modifiedAt: string };
type BannerVideo = { name: string; size: number; modifiedAt: string; thumbnail: BannerThumbnail | null };

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleString();
}

function getApiBase() {
  return import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
}

function getToken() {
  return localStorage.getItem("fishtokri_token") || "";
}

async function uploadFile(endpoint: string, file: File, fieldName: "video" | "thumbnail", method = "POST") {
  const formData = new FormData();
  formData.append(fieldName, file);
  const response = await fetch(`${getApiBase()}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${getToken()}` },
    body: formData,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Video upload failed.");
  return data;
}

function VideoThumbnailPreview({ endpoint, file }: { endpoint: string; file: BannerVideo }) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    if (!file.thumbnail) {
      setSrc("");
      return;
    }

    const controller = new AbortController();
    let objectUrl = "";
    fetch(`${getApiBase()}${endpoint}/files/${encodeURIComponent(file.name)}/thumbnail`, {
      headers: { Authorization: `Bearer ${getToken()}` },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Thumbnail unavailable");
        return response.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSrc("");
      });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [endpoint, file.name, file.thumbnail?.modifiedAt, file.thumbnail?.size]);

  return src ? (
    <img src={src} alt={`${file.name} thumbnail`} className="h-12 w-16 shrink-0 rounded-md border border-gray-200 bg-white object-cover" />
  ) : (
    <div className="flex h-12 w-16 shrink-0 items-center justify-center rounded-md border border-dashed border-gray-300 bg-white text-gray-400">
      <ImagePlus className="h-5 w-5" />
    </div>
  );
}

export function BannerVideosTab({ subHubId }: { subHubId: string }) {
  const { toast } = useToast();
  const canConfigureDirectory = getCurrentAdminScope().role === "master_admin";
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const thumbnailInputRef = useRef<HTMLInputElement>(null);
  const [directory, setDirectory] = useState("");
  const [directoryDraft, setDirectoryDraft] = useState("");
  const [files, setFiles] = useState<BannerVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingDirectory, setSavingDirectory] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [replacing, setReplacing] = useState("");
  const [replaceTarget, setReplaceTarget] = useState("");
  const [thumbnailAction, setThumbnailAction] = useState<{ fileName: string; replace: boolean } | null>(null);
  const [thumbnailBusy, setThumbnailBusy] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameFile, setRenameFile] = useState<BannerVideo | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteFile, setDeleteFile] = useState<BannerVideo | null>(null);
  const [deleteThumbnail, setDeleteThumbnail] = useState<BannerVideo | null>(null);
  const [storageError, setStorageError] = useState("");

  const endpoint = `/api/sub-hubs/${subHubId}/menu/banner-videos`;
  const load = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    try {
      const result = await apiFetch(endpoint);
      setDirectory(result.directory || "");
      setDirectoryDraft(result.directory || "");
      setFiles(Array.isArray(result.files) ? result.files : []);
      setStorageError("");
    } catch (error: any) {
      setStorageError(error.message || "Could not load videos from this VPS directory.");
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => { void load(); }, [load]);

  const handleSaveDirectory = async () => {
    setSavingDirectory(true);
    try {
      const result = await apiFetch(`${endpoint}/directory`, {
        method: "PUT",
        body: JSON.stringify({ directory: directoryDraft }),
      });
      setDirectory(result.directory || "");
      setDirectoryDraft(result.directory || "");
      setFiles(Array.isArray(result.files) ? result.files : []);
      setStorageError("");
      toast({
        title: result.directory ? "Video directory saved" : "Video directory cleared",
        description: result.directory ? `${result.total ?? 0} video file(s) found.` : undefined,
      });
    } catch (error: any) {
      toast({ title: "Could not save directory", description: error.message, variant: "destructive" });
    } finally {
      setSavingDirectory(false);
    }
  };

  const handleUpload = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    try {
      await uploadFile(`${endpoint}/files`, file, "video");
      await load(false);
      toast({ title: "Video uploaded", description: file.name });
    } catch (error: any) {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
    }
  };

  const handleReplace = async (file?: File) => {
    if (!file || !replaceTarget) return;
    const target = replaceTarget;
    setReplacing(target);
    try {
      await uploadFile(`${endpoint}/files/${encodeURIComponent(target)}/replace`, file, "video", "PUT");
      await load(false);
      toast({ title: "Video replaced", description: target });
    } catch (error: any) {
      toast({ title: "Replacement failed", description: error.message, variant: "destructive" });
    } finally {
      setReplacing("");
      setReplaceTarget("");
      if (replaceInputRef.current) replaceInputRef.current.value = "";
    }
  };

  const handleThumbnailUpload = async (file?: File) => {
    const action = thumbnailAction;
    if (!file || !action) {
      setThumbnailAction(null);
      return;
    }
    setThumbnailBusy(action.fileName);
    try {
      const method = action.replace ? "PUT" : "POST";
      await uploadFile(
        `${endpoint}/files/${encodeURIComponent(action.fileName)}/thumbnail`,
        file,
        "thumbnail",
        method,
      );
      await load(false);
      toast({ title: action.replace ? "Thumbnail replaced" : "Thumbnail uploaded", description: `${action.fileName} · ${file.name}` });
    } catch (error: any) {
      toast({ title: "Thumbnail upload failed", description: error.message, variant: "destructive" });
    } finally {
      setThumbnailBusy("");
      setThumbnailAction(null);
      if (thumbnailInputRef.current) thumbnailInputRef.current.value = "";
    }
  };

  const handleDeleteThumbnail = async () => {
    if (!deleteThumbnail) return;
    try {
      await apiFetch(`${endpoint}/files/${encodeURIComponent(deleteThumbnail.name)}/thumbnail`, { method: "DELETE" });
      await load(false);
      toast({ title: "Thumbnail deleted", description: deleteThumbnail.thumbnail?.name });
    } catch (error: any) {
      toast({ title: "Thumbnail delete failed", description: error.message, variant: "destructive" });
    } finally {
      setDeleteThumbnail(null);
    }
  };

  const openRename = (file: BannerVideo) => {
    setRenameFile(file);
    setRenameValue(file.name);
  };

  const handleRename = async () => {
    if (!renameFile) return;
    setRenaming(true);
    try {
      await apiFetch(`${endpoint}/files/${encodeURIComponent(renameFile.name)}`, {
        method: "PUT",
        body: JSON.stringify({ newFilename: renameValue.trim() }),
      });
      setRenameFile(null);
      await load(false);
      toast({ title: "Video renamed" });
    } catch (error: any) {
      toast({ title: "Rename failed", description: error.message, variant: "destructive" });
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteFile) return;
    try {
      await apiFetch(`${endpoint}/files/${encodeURIComponent(deleteFile.name)}`, { method: "DELETE" });
      setFiles((current) => current.filter((file) => file.name !== deleteFile.name));
      toast({ title: "Video deleted", description: deleteFile.name });
    } catch (error: any) {
      toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    } finally {
      setDeleteFile(null);
    }
  };

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-gray-200 bg-slate-50 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
              <FolderCog className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[#162B4D]">VPS video directory</h3>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-gray-500">
                Set an absolute folder path on the VPS for this sub-hub. The API service needs permission to read and write there.
              </p>
            </div>
          </div>
          {directory && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
              <HardDrive className="h-3.5 w-3.5" />
              {files.length} video{files.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor={`video-directory-${subHubId}`} className="text-xs font-medium text-gray-600">
              Directory path
            </Label>
            <Input
              id={`video-directory-${subHubId}`}
              value={directoryDraft}
              onChange={(event) => setDirectoryDraft(event.target.value)}
              placeholder="/var/www/freshstock/videos"
              disabled={!canConfigureDirectory || savingDirectory}
              className="h-9 bg-white font-mono text-xs"
            />
          </div>
          {canConfigureDirectory && (
            <Button
              type="button"
              onClick={handleSaveDirectory}
              disabled={savingDirectory || (directoryDraft.trim() === directory && !storageError)}
              className="mt-auto h-9 bg-[#1A56DB] hover:bg-[#1447B4]"
            >
              {savingDirectory ? "Checking…" : "Save directory"}
            </Button>
          )}
        </div>
        {!canConfigureDirectory && (
          <p className="mt-2 text-xs text-amber-700">Only a Master Admin can change this VPS path.</p>
        )}
        {directory && (
          <p className="mt-2 break-all text-[11px] text-gray-500">Configured for this sub-hub: {directory}</p>
        )}
        {storageError && (
          <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {storageError}
          </p>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[#162B4D]">Videos in this folder</h3>
          <p className="mt-0.5 text-xs text-gray-500">Files in subfolders are not included. Upload limit: 500 MB per video, 15 MB per JPG thumbnail.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={() => void load()} disabled={loading} className="h-9">
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            type="button"
            onClick={() => uploadInputRef.current?.click()}
            disabled={!directory || uploading}
            className="h-9 bg-[#1A56DB] hover:bg-[#1447B4]"
          >
            <Upload className="mr-2 h-3.5 w-3.5" />
            {uploading ? "Uploading…" : "Upload video"}
          </Button>
          <input
            ref={uploadInputRef}
            type="file"
            accept="video/*,.mp4,.mov,.webm,.m4v,.mkv,.avi,.ogv,.mpeg,.mpg,.3gp"
            className="hidden"
            onChange={(event) => { const file = event.target.files?.[0]; void handleUpload(file); }}
          />
          <input
            ref={replaceInputRef}
            type="file"
            accept="video/*,.mp4,.mov,.webm,.m4v,.mkv,.avi,.ogv,.mpeg,.mpg,.3gp"
            className="hidden"
            onChange={(event) => { const file = event.target.files?.[0]; void handleReplace(file); }}
          />
          <input
            ref={thumbnailInputRef}
            type="file"
            accept=".jpg,image/jpeg"
            className="hidden"
            onChange={(event) => { const file = event.target.files?.[0]; void handleThumbnailUpload(file); }}
          />
        </div>
      </div>

      {loading ? (
        <div className="rounded-xl border border-gray-100 px-4 py-12 text-center text-sm text-gray-400">Loading video files…</div>
      ) : !directory ? (
        <div className="rounded-xl border border-dashed border-gray-300 px-4 py-12 text-center">
          <FolderCog className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-3 text-sm font-medium text-gray-600">Set a VPS directory to manage videos</p>
          <p className="mt-1 text-xs text-gray-400">Each sub-hub can use a different folder.</p>
        </div>
      ) : storageError ? null : files.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 px-4 py-12 text-center">
          <Video className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-3 text-sm font-medium text-gray-600">No videos found in this folder</p>
          <p className="mt-1 text-xs text-gray-400">Upload a video or check that the configured directory is correct.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200">
          <div className="hidden grid-cols-[minmax(0,1fr)_72px_minmax(0,160px)_minmax(220px,240px)] gap-3 bg-slate-50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500 md:grid">
            <span>Video</span><span>File size</span><span>Last modified</span><span className="text-right">Actions</span>
          </div>
          <div className="divide-y divide-gray-100">
            {files.map((file) => (
              <div key={file.name} className="flex flex-col gap-3 px-4 py-3 md:grid md:grid-cols-[minmax(0,1fr)_72px_minmax(0,160px)_minmax(220px,240px)] md:items-center md:gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-12 shrink-0 items-center justify-center rounded-md bg-slate-100 text-blue-700">
                    <Video className="h-5 w-5" />
                  </div>
                  <p className="min-w-0 break-all text-sm font-medium text-gray-800">{file.name}</p>
                </div>
                <span className="text-xs text-gray-500 md:whitespace-nowrap">{formatBytes(file.size)}</span>
                <span className="min-w-0 break-words text-xs text-gray-500">{formatDate(file.modifiedAt)}</span>
                <div className="flex min-w-0 flex-wrap items-center justify-start gap-1.5 md:justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!!replacing}
                    onClick={() => {
                      setReplaceTarget(file.name);
                      replaceInputRef.current?.click();
                    }}
                    className="h-8 shrink-0 px-2 text-xs"
                  >
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    {replacing === file.name ? "Replacing…" : "Replace"}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => openRename(file)} className="h-8 shrink-0 px-2 text-xs">
                    <Pencil className="mr-1.5 h-3.5 w-3.5" /> Rename
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setDeleteFile(file)}
                    className="h-8 shrink-0 border-red-200 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete
                  </Button>
                </div>
                <div className="col-span-full flex min-w-0 flex-wrap items-center gap-3 border-t border-gray-100 pt-3">
                  <VideoThumbnailPreview endpoint={endpoint} file={file} />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-gray-700">JPG thumbnail</p>
                    <p className="break-all text-xs text-gray-500">
                      {file.thumbnail?.name ?? "Not uploaded"} · Must match the video name
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={thumbnailBusy === file.name || (!!thumbnailBusy && thumbnailBusy !== file.name)}
                      onClick={() => {
                        setThumbnailAction({ fileName: file.name, replace: !!file.thumbnail });
                        thumbnailInputRef.current?.click();
                      }}
                      className="h-8 px-2.5 text-xs"
                    >
                      <Upload className="mr-1.5 h-3.5 w-3.5" />
                      {thumbnailBusy === file.name ? "Uploading…" : file.thumbnail ? "Replace thumbnail" : "Upload thumbnail"}
                    </Button>
                    {file.thumbnail && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setDeleteThumbnail(file)}
                        disabled={!!thumbnailBusy}
                        className="h-8 border-red-200 px-2.5 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                      >
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete thumbnail
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <Dialog open={!!renameFile} onOpenChange={(open) => !open && setRenameFile(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename video</DialogTitle>
            <DialogDescription>The paired JPG thumbnail will be renamed with the video. Keep the existing video extension.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="banner-video-new-name">Filename</Label>
            <Input id="banner-video-new-name" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRenameFile(null)}>Cancel</Button>
            <Button type="button" onClick={handleRename} disabled={renaming || !renameValue.trim()} className="bg-[#1A56DB] hover:bg-[#1447B4]">
              {renaming ? "Saving…" : "Save name"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteFile} onOpenChange={(open) => !open && setDeleteFile(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this video?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes “{deleteFile?.name}” and its paired JPG thumbnail, if present, from the configured VPS folder. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-red-600 hover:bg-red-700">Delete video</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteThumbnail} onOpenChange={(open) => !open && setDeleteThumbnail(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this thumbnail?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes “{deleteThumbnail?.thumbnail?.name}”. The video will remain in the folder.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteThumbnail} className="bg-red-600 hover:bg-red-700">Delete thumbnail</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
