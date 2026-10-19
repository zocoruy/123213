import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertCircle, Aperture, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight,
  CalendarDays, Camera, Check, CheckCheck, CheckCircle2, ChevronDown,
  ChevronLeft, ChevronRight, Clock3, Copy, FileImage, Focus, FolderOpen,
  FolderOutput, Grid2X2, HardDrive, Image as ImageIcon, Info, Keyboard,
  LoaderCircle, Maximize2, Plus, ScanText, Search, Settings2, ShieldCheck,
  SkipForward, SlidersHorizontal, SplitSquareHorizontal, Star, Tag, Undo2,
  Users, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from './api';
import type { Album, AnalysisSettings, ExportOptions, Photo, PhotoPatch, Progress } from '../shared/types';
import { DEFAULT_ANALYSIS } from '../shared/types';

type Category = 'all' | 'unreviewed' | 'keep' | 'reject' | 'similar' | 'blurry' | 'athletes';
type Modal = 'analysis' | 'export' | 'time' | 'help' | 'compare' | 'preview' | 'errors' | null;
type Notice = { message: string; kind: 'success' | 'error' | 'info' };
type UndoEntry = { before: { id: string; patch: PhotoPatch }[]; label: string; activeId: string | null };
const CATEGORY_NAMES: Record<Category, string> = {
  all: '全部照片', unreviewed: '待筛选', keep: '已保留', reject: '已淘汰',
  similar: '相似照片', blurry: '可能模糊', athletes: '运动员',
};

function localDate(value: string, options?: Intl.DateTimeFormatOptions) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', options ?? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function readableBytes(bytes: number) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function normalizeTokens(value: string): string[] {
  return [...new Set(value.split(/[,，;；\s]+/).map((v) => v.trim()).filter(Boolean))];
}

function ModalFrame({ title, subtitle, children, onClose, wide = false }: {
  title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab' && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')];
        if (!items.length) { event.preventDefault(); return; }
        const first = items[0]; const last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panel}>
      <div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={19} /></button></div>
      {children}
    </div>
  </div>;
}

function Rating({ value, onChange, compact = false, disabled = false }: {
  value: number; onChange?: (value: number) => void; compact?: boolean; disabled?: boolean;
}) {
  return <div className={`rating ${compact ? 'rating-small' : ''}`} aria-label={`${value} 星`}>
    {[1, 2, 3, 4, 5].map((star) => onChange
      ? <button key={star} title={`${star} 星（再次点击清除）`} aria-label={`评为 ${star} 星`} disabled={disabled} onClick={() => onChange(star === value ? 0 : star)}><Star size={compact ? 11 : 19} className={star <= value ? 'filled' : ''} /></button>
      : <Star key={star} size={11} className={star <= value ? 'filled' : ''} />)}
  </div>;
}

export default function App() {
  const [album, setAlbum] = useState<Album | null>(null);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState<Category>('all');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [clarity, setClarity] = useState('all');
  const [decisionFilter, setDecisionFilter] = useState('all');
  const [sort, setSort] = useState('time');
  const [groupBy, setGroupBy] = useState<'none' | 'hour' | 'day'>('hour');
  const [timeFrom, setTimeFrom] = useState('');
  const [timeTo, setTimeTo] = useState('');
  const [timeDraft, setTimeDraft] = useState({ from: '', to: '' });
  const [view, setView] = useState<'grid' | 'single'>('grid');
  const [visibleCount, setVisibleCount] = useState(60);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [analysis, setAnalysis] = useState<AnalysisSettings>(DEFAULT_ANALYSIS);
  const [exportMode, setExportMode] = useState<'keep' | 'selected'>('keep');
  const [exportGroup, setExportGroup] = useState<ExportOptions['groupBy']>('athlete');
  const [undoEntries, setUndoEntries] = useState<UndoEntry[]>([]);
  const [bibDraft, setBibDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [batchDraft, setBatchDraft] = useState('');
  const [batchField, setBatchField] = useState<'athleteTags' | 'bibNumbers'>('athleteTags');
  const [activeAthlete, setActiveAthlete] = useState<string | null>(null);
  const [operationErrors, setOperationErrors] = useState<{ path: string; message: string }[]>([]);
  const [compareGroup, setCompareGroup] = useState<string | null>(null);
  const [infoExpanded, setInfoExpanded] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelRequestedRef = useRef(false);
  const albumRef = useRef<Album | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const photoRegion = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  albumRef.current = album;

  useEffect(() => {
    let alive = true;
    const unsubscribe = api.onProgress((update) => { if (alive) setProgress(update); });
    api.getAlbum().then((result) => {
      if (!alive) return;
      setAlbum(result); setActiveId(result?.photos[0]?.id ?? null);
    }).catch((error) => { if (alive) setNotice({ message: error instanceof Error ? error.message : '相册加载失败，请重新导入。', kind: 'error' }); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; unsubscribe(); };
  }, []);

  useEffect(() => { if (!notice || notice.kind === 'error') return; const timer = window.setTimeout(() => setNotice(null), 6500); return () => window.clearTimeout(timer); }, [notice]);
  const notify = useCallback((message: string, kind: Notice['kind'] = 'success') => setNotice({ message, kind }), []);
  const photos = album?.photos ?? [];
  const isDemo = Boolean(album?.sourceDir.startsWith('demo:'));
  const active = photos.find((photo) => photo.id === activeId) ?? null;
  const stats = useMemo(() => ({
    all: photos.length,
    unreviewed: photos.filter((photo) => photo.decision === 'unreviewed').length,
    keep: photos.filter((photo) => photo.decision === 'keep').length,
    reject: photos.filter((photo) => photo.decision === 'reject').length,
    similar: photos.filter((photo) => photo.similarGroupId).length,
    blurry: photos.filter((photo) => photo.isBlurry).length,
    athletes: new Set(photos.flatMap((photo) => [...photo.bibNumbers, ...photo.athleteTags])).size,
  }), [photos]);
  const athletes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const photo of photos) for (const name of new Set([...photo.bibNumbers, ...photo.athleteTags])) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [photos]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const from = timeFrom ? new Date(timeFrom).getTime() : -Infinity;
    const to = timeTo ? new Date(timeTo).getTime() : Infinity;
    return photos.filter((photo) => {
      if (['unreviewed', 'keep', 'reject'].includes(category) && photo.decision !== category) return false;
      if (category === 'similar' && !photo.similarGroupId) return false;
      if (category === 'blurry' && !photo.isBlurry) return false;
      if (category === 'athletes' && !photo.bibNumbers.length && !photo.athleteTags.length) return false;
      if (category === 'athletes' && activeAthlete && ![...photo.bibNumbers, ...photo.athleteTags].includes(activeAthlete)) return false;
      if (decisionFilter !== 'all' && photo.decision !== decisionFilter) return false;
      if (clarity === 'sharp' && photo.isBlurry) return false;
      if (clarity === 'blurry' && !photo.isBlurry) return false;
      const captured = new Date(photo.capturedAt).getTime();
      if ((timeFrom || timeTo) && (Number.isNaN(captured) || captured < from || captured > to)) return false;
      return !query || [photo.fileName, photo.relativePath, ...photo.bibNumbers, ...photo.athleteTags].some((value) => value.toLocaleLowerCase().includes(query));
    }).sort((a, b) => sort === 'name' ? a.fileName.localeCompare(b.fileName, 'zh-CN', { numeric: true })
      : sort === 'sharpness' ? b.sharpness - a.sharpness : sort === 'rating' ? b.rating - a.rating
      : new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());
  }, [photos, category, activeAthlete, search, decisionFilter, clarity, sort, timeFrom, timeTo]);
  const activeIndex = filtered.findIndex((photo) => photo.id === activeId);
  const similarPhotos = active?.similarGroupId ? photos.filter((photo) => photo.similarGroupId === active.similarGroupId) : [];
  const comparedPhotos = compareGroup ? photos.filter((photo) => photo.similarGroupId === compareGroup) : [];
  const progressPercent = progress?.total ? Math.min(100, Math.round(progress.current / progress.total * 100)) : 0;
  const reviewedPercent = photos.length ? Math.round((stats.keep + stats.reject) / photos.length * 100) : 0;
  const exportIds = exportMode === 'keep' ? photos.filter((photo) => photo.decision === 'keep').map((photo) => photo.id) : [...selected];

  useEffect(() => {
    if (filtered.length && !filtered.some((photo) => photo.id === activeId)) setActiveId(filtered[0].id);
    else if (!filtered.length) setActiveId(null);
  }, [filtered, activeId]);
  useEffect(() => { setVisibleCount(60); photoRegion.current?.scrollTo({ top: 0 }); }, [category, search, clarity, decisionFilter, sort, groupBy, timeFrom, timeTo, activeAthlete]);
  useEffect(() => { setBibDraft(''); setTagDraft(''); }, [activeId]);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || view !== 'grid') return;
    const observer = new IntersectionObserver((entries) => { if (entries[0].isIntersecting) setVisibleCount((value) => Math.min(value + 60, filtered.length)); }, { root: photoRegion.current, rootMargin: '450px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [filtered.length, visibleCount, view]);

  const closeModal = useCallback(() => setModal(null), []);
  const runTask = useCallback(async (label: string, task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; cancelRequestedRef.current = false; setBusy(label); setCancelRequested(false);
    try { await task(); }
    catch (error) { notify(error instanceof Error ? error.message : '操作未完成，请重试。', 'error'); }
    finally { busyRef.current = false; cancelRequestedRef.current = false; setBusy(null); setProgress(null); setCancelRequested(false); }
  }, [notify]);

  const applyPatch = useCallback(async (ids: string[], patch: PhotoPatch, label: string, advance = false) => {
    if (!ids.length || busyRef.current) return;
    const current = albumRef.current;
    if (!current) return;
    const before = current.photos.filter((photo) => ids.includes(photo.id)).map((photo) => {
      const oldPatch: PhotoPatch = {};
      if ('decision' in patch) oldPatch.decision = photo.decision;
      if ('rating' in patch) oldPatch.rating = photo.rating;
      if ('bibNumbers' in patch) oldPatch.bibNumbers = [...photo.bibNumbers];
      if ('athleteTags' in patch) oldPatch.athleteTags = [...photo.athleteTags];
      return { id: photo.id, patch: oldPatch };
    });
    const position = filtered.findIndex((photo) => photo.id === activeId);
    const nextId = filtered[position + 1]?.id ?? filtered[position - 1]?.id ?? activeId;
    await runTask(label, async () => {
      const result = await api.updatePhotos(ids, patch);
      setAlbum(result);
      setUndoEntries((entries) => [...entries.slice(-19), { before, label, activeId }]);
      if (advance && ids.length === 1) setActiveId(nextId);
      if (ids.length > 1) notify(`${label} · ${ids.length} 张照片`);
    });
  }, [activeId, filtered, notify, runTask]);

  const undo = useCallback(async () => {
    const entry = undoEntries[undoEntries.length - 1];
    if (!entry || busyRef.current) return;
    await runTask('正在撤销', async () => {
      const groups = new Map<string, { ids: string[]; patch: PhotoPatch }>();
      for (const item of entry.before) {
        const key = JSON.stringify(item.patch);
        if (!groups.has(key)) groups.set(key, { ids: [], patch: item.patch });
        groups.get(key)!.ids.push(item.id);
      }
      for (const group of groups.values()) setAlbum(await api.updatePhotos(group.ids, group.patch));
      setUndoEntries((entries) => entries.slice(0, -1)); setActiveId(entry.activeId);
      notify(`已撤销：${entry.label}`);
    });
  }, [undoEntries, runTask, notify]);

  const navigate = useCallback((direction: number) => {
    if (!filtered.length) return;
    const index = Math.max(0, filtered.findIndex((photo) => photo.id === activeId));
    setActiveId(filtered[Math.max(0, Math.min(filtered.length - 1, index + direction))].id);
  }, [filtered, activeId]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const element = event.target as HTMLElement;
      if (modal || event.repeat || element.closest('input, textarea, select, [contenteditable="true"]') || event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === '/') { event.preventDefault(); searchInput.current?.focus(); return; }
      if (key === 'z') { event.preventDefault(); void undo(); return; }
      if (!active || busyRef.current) return;
      if (key === 'k' || key === 'arrowright') { event.preventDefault(); void applyPatch([active.id], { decision: 'keep' }, '标记保留', true); }
      else if (key === 'j' || key === 'arrowleft') { event.preventDefault(); void applyPatch([active.id], { decision: 'reject' }, '标记淘汰', true); }
      else if (key === 'u') { event.preventDefault(); navigate(1); }
      else if (key === 'a' || key === 'arrowup') { event.preventDefault(); navigate(-1); }
      else if (key === 'd' || key === 'arrowdown') { event.preventDefault(); navigate(1); }
      else if (key === ' ') { event.preventDefault(); setModal('preview'); }
      else if (/^[1-5]$/.test(key)) { event.preventDefault(); void applyPatch([active.id], { rating: Number(key) }, `评为 ${key} 星`); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, applyPatch, undo, navigate, modal]);

  const importFolder = () => runTask('正在导入照片', async () => {
    const imported = await api.importFolder();
    if (!imported) return;
    if (cancelRequestedRef.current) {
      setAlbum(imported);
      notify('导入已停止，已完成的进度已保存。可再次选择该文件夹继续导入。', 'info');
      return;
    }
    setAlbum(imported); setActiveId(imported.photos[0]?.id ?? null); setSelected(new Set());
    setUndoEntries([]); setCategory('all'); setSearch(''); setClarity('all'); setDecisionFilter('all'); setTimeFrom(''); setTimeTo('');
    setOperationErrors(imported.errors);
    notify(`已导入 ${imported.photos.length.toLocaleString()} 张照片${imported.errors.length ? `，${imported.errors.length} 个文件未能读取，可查看详情` : '，开始发现精彩瞬间。'}`, imported.errors.length ? 'info' : 'success');
  });
  const runAnalysis = () => {
    closeModal();
    void runTask('正在分析照片', async () => { setAlbum(await api.analyze(analysis)); notify('分析完成，相似连拍与可能模糊的照片已整理。'); });
  };
  const recognizeBibs = () => runTask('正在识别号码布', async () => {
    const targetIds = selected.size ? new Set(selected) : null;
    const result = await api.recognizeBibs(targetIds ? [...targetIds] : undefined);
    setAlbum(result);
    if (cancelRequestedRef.current) { notify('号码识别已停止，已完成的识别结果已保存。', 'info'); return; }
    const errors = result.photos.filter((photo) => photo.ocrStatus === 'error' && (!targetIds || targetIds.has(photo.id))).map((photo) => ({ path: photo.fileName, message: photo.ocrError ?? '识别未完成' }));
    setOperationErrors(errors);
    notify(`号码布识别完成${errors.length ? `，${errors.length} 张未能识别，可查看详情` : '，可搜索号码快速找人。'}`, errors.length ? 'info' : 'success');
  });
  const exportPhotos = () => {
    if (!exportIds.length) return;
    const ids = [...exportIds]; closeModal();
    void runTask('正在导出照片', async () => {
      const result = await api.exportPhotos({ photoIds: ids, groupBy: exportGroup });
      if (!result) return;
      setOperationErrors(result.errors);
      notify(`${cancelRequestedRef.current ? '导出已停止，' : ''}已复制 ${result.copied} 个文件至 ${result.directory}${result.errors.length ? `，${result.errors.length} 个文件失败，可查看详情` : ''}`, result.errors.length || cancelRequestedRef.current ? 'info' : 'success');
    });
  };
  const cancelOperation = async () => {
    cancelRequestedRef.current = true; setCancelRequested(true);
    try { await api.cancelOperation(); notify('已请求取消，正在完成当前文件…', 'info'); }
    catch (error) { cancelRequestedRef.current = false; setCancelRequested(false); notify(error instanceof Error ? error.message : '取消失败，请稍后重试。', 'error'); }
  };
  const selectCategory = (next: Category) => { setCategory(next); setActiveAthlete(null); setSelected(new Set()); };
  const toggleSelection = (id: string) => setSelected((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const clearFilters = () => { setSearch(''); setClarity('all'); setDecisionFilter('all'); setTimeFrom(''); setTimeTo(''); setActiveAthlete(null); };
  const changeTag = (field: 'bibNumbers' | 'athleteTags', value: string, remove = false) => {
    if (!active) return;
    const tokens = normalizeTokens(value);
    if (!tokens.length) return;
    const patch = remove ? active[field].filter((item) => !tokens.includes(item)) : [...new Set([...active[field], ...tokens])];
    void applyPatch([active.id], { [field]: patch }, field === 'bibNumbers' ? '更新号码布' : '更新人物标签');
    if (field === 'bibNumbers') setBibDraft(''); else setTagDraft('');
  };

  const visibleGroups = useMemo(() => {
    const groups = new Map<string, Photo[]>();
    for (const photo of filtered.slice(0, visibleCount)) {
      let key = '';
      if (category === 'similar') key = photo.similarGroupId ?? '';
      else if (groupBy !== 'none') key = localDate(photo.capturedAt, groupBy === 'day' ? { year: 'numeric', month: 'long', day: 'numeric' } : { month: 'long', day: 'numeric', hour: '2-digit' });
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(photo);
    }
    return [...groups.entries()];
  }, [filtered, visibleCount, groupBy, category]);

  const openCompare = (id: string | null) => { if (id) { setCompareGroup(id); setModal('compare'); } };

  function navItem(key: Category, Icon: LucideIcon) {
    return <button key={key} className={`nav-item ${category === key ? 'active' : ''}`} onClick={() => selectCategory(key)}>
      <Icon size={17} strokeWidth={1.7} /><span>{CATEGORY_NAMES[key]}</span><span className="nav-count">{stats[key].toLocaleString()}</span>
    </button>;
  }

  function photoCard(photo: Photo) {
    const checked = selected.has(photo.id);
    return <article key={photo.id} className={`photo-card ${activeId === photo.id ? 'is-active' : ''} ${checked ? 'is-selected' : ''}`}>
      <div className="photo-image" role="button" tabIndex={0} aria-label={`查看 ${photo.fileName}`} aria-pressed={activeId === photo.id}
        onClick={() => setActiveId(photo.id)} onDoubleClick={() => { setActiveId(photo.id); setModal('preview'); }}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); setActiveId(photo.id); } }}>
        <img src={photo.thumbnailUrl} alt={photo.fileName} loading="lazy" decoding="async" />
        <button className={`photo-check ${checked ? 'checked' : ''}`} aria-label={`${checked ? '取消选择' : '选择'} ${photo.fileName}`} aria-pressed={checked} onClick={(event) => { event.stopPropagation(); toggleSelection(photo.id); }}>{checked && <Check size={13} strokeWidth={3} />}</button>
        <div className="photo-badges">{photo.decision === 'keep' && <span className="image-badge keep-badge"><Check size={11} />已保留</span>}{photo.decision === 'reject' && <span className="image-badge reject-badge"><X size={11} />已淘汰</span>}{photo.isBlurry && <span className="image-badge blur-badge"><Focus size={11} />可能模糊</span>}</div>
        {photo.similarGroupId && <button className="similar-count" title="并排比较相似照片" onClick={(event) => { event.stopPropagation(); setActiveId(photo.id); openCompare(photo.similarGroupId); }}><Copy size={12} />{photos.filter((item) => item.similarGroupId === photo.similarGroupId).length}</button>}
        <button className="photo-expand" aria-label={`放大 ${photo.fileName}`} onClick={(event) => { event.stopPropagation(); setActiveId(photo.id); setModal('preview'); }}><Maximize2 size={14} /></button>
      </div>
      <div className="photo-caption" onClick={() => setActiveId(photo.id)}><div className="photo-name"><span title={photo.fileName}>{photo.fileName}</span>{photo.rating > 0 && <span className="tiny-rating"><Star size={10} fill="currentColor" />{photo.rating}</span>}</div><div className="photo-meta"><span>{localDate(photo.capturedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>{photo.bibNumbers.length > 0 ? <span className="photo-bib">#{photo.bibNumbers.join(' · #')}</span> : <span>{photo.width} × {photo.height}</span>}</div></div>
    </article>;
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={(event) => { event.preventDefault(); selectCategory('all'); }}><span className="brand-mark"><Aperture size={23} strokeWidth={2.3} /></span><span><strong>Sprint<span>Select</span></strong><small>赛事影像工作台</small></span></a>
      <div className="workspace-label"><span>工作空间</span><span className="local-dot">本地</span></div>
      <button className="album-switch" disabled={Boolean(busy)} onClick={() => void importFolder()} title="导入其他相册"><span className="album-symbol"><FolderOpen size={18} /></span><span><strong>{album?.name ?? '我的赛事相册'}</strong><small>{isDemo ? '示例赛事 · 体验工作流程' : album ? `${photos.length.toLocaleString()} 张照片` : '导入文件夹开始'}</small></span><ChevronDown size={13} /></button>
      <div className="nav-section-label">照片图库</div>
      <nav aria-label="照片分类">{navItem('all', Grid2X2)}{navItem('unreviewed', Clock3)}{navItem('keep', CheckCircle2)}{navItem('reject', X)}</nav>
      <div className="nav-section-label">智能整理 <span className="new-label">SMART</span></div>
      <nav aria-label="智能分类">{navItem('similar', Copy)}{navItem('blurry', Focus)}{navItem('athletes', Users)}</nav>
      {athletes.length > 0 && <><div className="nav-section-label athlete-heading">最近识别<button title="查看全部运动员" aria-label="查看全部运动员" onClick={() => selectCategory('athletes')}><ArrowUpRight size={13} /></button></div><div className="athlete-nav">{athletes.slice(0, 4).map(([athlete, count], index) => <button key={athlete} className={category === 'athletes' && activeAthlete === athlete ? 'active' : ''} onClick={() => { setCategory('athletes'); setActiveAthlete(athlete); setSelected(new Set()); }}><span className={`athlete-avatar avatar-${index}`}>{/^\d+$/.test(athlete) ? '#' : athlete.slice(0, 1)}</span><span>{/^\d+$/.test(athlete) ? `选手 ${athlete}` : athlete}</span><small>{count}</small></button>)}</div></>}
      <div className="sidebar-bottom"><div className="review-summary"><div><span>筛选进度</span><strong>{reviewedPercent}<small>%</small></strong></div><div className="thin-progress"><span style={{ width: `${reviewedPercent}%` }} /></div><p>已筛选 {(stats.keep + stats.reject).toLocaleString()} / {photos.length.toLocaleString()} 张</p></div><div className="privacy-note"><ShieldCheck size={15} /><span>照片留在本机，创作安心。</span></div><button className="sidebar-help" onClick={() => setModal('help')}><Keyboard size={15} />快捷键与使用帮助<ArrowUpRight size={13} /></button></div>
    </aside>

    <div className="workspace">
      <header className="topbar"><div className="breadcrumb"><span>我的相册</span><ChevronRight size={13} /><strong>{album?.name ?? '新建相册'}</strong>{isDemo && <span className="demo-label">演示相册</span>}</div><div className="top-actions"><button className="button subtle import-button" disabled={Boolean(busy)} onClick={() => void importFolder()}><FolderOpen size={15} />导入文件夹</button><button className="button subtle ocr-button" disabled={Boolean(busy) || !photos.length} onClick={() => void recognizeBibs()} title={selected.size ? `识别已选择的 ${selected.size} 张照片` : '识别所有照片的号码布'}><ScanText size={16} />识别号码布</button><button className="button primary" disabled={Boolean(busy) || (!stats.keep && !selected.size)} onClick={() => { setExportMode(selected.size ? 'selected' : 'keep'); setModal('export'); }}><ArrowDownToLine size={15} />导出照片{stats.keep > 0 && <span className="button-count">{selected.size || stats.keep}</span>}</button></div></header>
      <div className="workbody"><main className="main-area">
        <section className="page-heading"><div><div className="eyebrow">YOUR MOMENTS, IN FOCUS</div><h1>{CATEGORY_NAMES[category]} <span>{filtered.length.toLocaleString()}</span></h1><p>{category === 'similar' ? '连拍中的每一次细微差别，都值得认真比较。' : category === 'blurry' ? '清晰度仅供参考，由你决定每一张的去留。' : category === 'athletes' ? '按号码布和人物标签，快速找到每一位运动员。' : '把时间留给拍摄，把精彩留在这里。'}</p></div><button className="button analysis-button" disabled={Boolean(busy) || !photos.length} onClick={() => setModal('analysis')}><span className="sparkle-icon">✧</span>智能分析<Settings2 size={13} /></button></section>
        {isDemo && <div className="demo-notice"><Info size={12} /><span>正在浏览示例照片 · 导入、号码识别和原片导出请使用 Windows 客户端</span></div>}
        <div className="overview-strip"><div><span className="stat-dot neutral" /><span>待筛选</span><strong>{stats.unreviewed.toLocaleString()}</strong></div><div><span className="stat-dot lime" /><span>已保留</span><strong>{stats.keep.toLocaleString()}</strong></div><div><span className="stat-dot muted-red" /><span>已淘汰</span><strong>{stats.reject.toLocaleString()}</strong></div><div className="overview-hint"><CheckCheck size={14} /><span>每次选择，自动保存</span></div></div>

        <div className="filter-toolbar"><label className="search-box"><Search size={16} /><input ref={searchInput} placeholder="搜索号码布、文件名或人物标签…" aria-label="搜索照片" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button aria-label="清空搜索" onClick={() => setSearch('')}><X size={13} /></button>}<kbd>/</kbd></label><button className={`button filter-button ${timeFrom || timeTo ? 'filter-active' : ''}`} title="设置拍摄时间范围" onClick={() => { setTimeDraft({ from: timeFrom, to: timeTo }); setModal('time'); }}><CalendarDays size={15} /><span>{timeFrom || timeTo ? '已选时段' : '全部时间'}</span><ChevronDown size={12} /></button><label className="select-wrap clarity-select"><SlidersHorizontal size={14} /><select aria-label="清晰度筛选" value={clarity} onChange={(event) => setClarity(event.target.value)}><option value="all">清晰度</option><option value="sharp">清晰照片</option><option value="blurry">可能模糊</option></select></label></div>
        <div className="view-toolbar"><div className="view-toolbar-left"><button className={`select-all ${selected.size && filtered.every((photo) => selected.has(photo.id)) ? 'all-selected' : ''}`} aria-label="全选当前筛选结果" title="全选当前筛选结果" onClick={() => { const allSelected = filtered.length > 0 && filtered.every((photo) => selected.has(photo.id)); setSelected(allSelected ? new Set() : new Set(filtered.map((photo) => photo.id))); }} disabled={!filtered.length}><span>{filtered.length > 0 && filtered.every((photo) => selected.has(photo.id)) && <Check size={11} />}</span></button><span className="results-label">{selected.size ? `已选择 ${selected.size.toLocaleString()} 张` : `${filtered.length.toLocaleString()} 张照片`}</span><span className="toolbar-divider" /><label className="plain-select"><select value={decisionFilter} aria-label="筛选状态" onChange={(event) => setDecisionFilter(event.target.value)}><option value="all">全部状态</option><option value="unreviewed">待筛选</option><option value="keep">已保留</option><option value="reject">已淘汰</option></select></label>{(search || clarity !== 'all' || decisionFilter !== 'all' || timeFrom || timeTo || activeAthlete) && <button className="reset-filter" onClick={clearFilters}>重置筛选</button>}</div><div className="view-toolbar-right"><label className="plain-select sort-select"><select aria-label="照片排序" value={sort} onChange={(event) => setSort(event.target.value)}><option value="time">拍摄时间 ↑</option><option value="name">文件名称 ↑</option><option value="sharpness">清晰度优先</option><option value="rating">星级优先</option></select></label><label className="plain-select grouping-select"><select aria-label="照片分组" value={groupBy} onChange={(event) => setGroupBy(event.target.value as typeof groupBy)}><option value="hour">按小时分组</option><option value="day">按日期分组</option><option value="none">不分组</option></select></label><div className="view-toggle"><button className={view === 'grid' ? 'active' : ''} title="网格视图" aria-label="网格视图" onClick={() => setView('grid')}><Grid2X2 size={15} /></button><button className={view === 'single' ? 'active' : ''} title="单张视图" aria-label="单张视图" onClick={() => setView('single')}><ImageIcon size={15} /></button></div></div></div>

        {category === 'athletes' && athletes.length > 0 && <div className="athlete-chips"><button className={!activeAthlete ? 'active' : ''} onClick={() => setActiveAthlete(null)}>全部运动员</button>{athletes.map(([name, count]) => <button key={name} className={activeAthlete === name ? 'active' : ''} onClick={() => setActiveAthlete(name)}>{/^\d+$/.test(name) ? '#' : ''}{name}<span>{count}</span></button>)}</div>}
        {selected.size > 0 && <div className="batch-bar"><div className="batch-count"><CheckCircle2 size={15} /><strong>{selected.size} 张</strong><button onClick={() => setSelected(new Set())}>取消选择</button></div><div className="batch-actions"><button disabled={Boolean(busy)} onClick={() => void applyPatch([...selected], { decision: 'keep' }, '批量保留')}><Check size={14} />保留</button><button disabled={Boolean(busy)} onClick={() => void applyPatch([...selected], { decision: 'reject' }, '批量淘汰')}><X size={14} />淘汰</button><select aria-label="批量编辑字段" value={batchField} onChange={(event) => setBatchField(event.target.value as typeof batchField)}><option value="athleteTags">人物标签</option><option value="bibNumbers">号码布</option></select><input aria-label="批量编辑内容" placeholder="多个用逗号分隔" value={batchDraft} onChange={(event) => setBatchDraft(event.target.value)} /><button disabled={Boolean(busy) || !normalizeTokens(batchDraft).length} onClick={() => { const value = normalizeTokens(batchDraft); void applyPatch([...selected], { [batchField]: value }, batchField === 'athleteTags' ? '批量设置人物标签' : '批量设置号码布'); setBatchDraft(''); }} title="替换选中照片的该字段">应用</button><button className="batch-export" disabled={Boolean(busy)} onClick={() => { setExportMode('selected'); setModal('export'); }}><FolderOutput size={14} />导出</button></div></div>}

        <div className="photo-region" ref={photoRegion}>
          {loading ? <div className="empty-state"><LoaderCircle size={30} className="spinning" /><h2>正在打开你的工作空间</h2><p>精彩即将就位。</p></div>
            : !photos.length ? <div className="empty-state import-empty"><div className="empty-art"><ImagesIcon /></div><span className="eyebrow">READY FOR THE NEXT SHOT</span><h2>你的精彩，值得被看见。</h2><p>导入赛事照片文件夹，一次整理数千张照片。<br />识别号码布、比较连拍、快速留下最佳瞬间。</p><button className="button primary" disabled={Boolean(busy)} onClick={() => void importFolder()}><FolderOpen size={16} />导入照片文件夹</button><small>支持 JPEG、PNG、WebP、TIFF · 所有处理在本地完成</small></div>
              : !filtered.length ? <div className="empty-state"><Search size={30} /><h2>这里暂时没有照片</h2><p>试试其他关键词或调整筛选条件。</p><button className="button secondary" onClick={clearFilters}>重置筛选条件</button>{category !== 'all' && <button className="text-button" onClick={() => selectCategory('all')}>查看全部照片 <ArrowRight size={14} /></button>}</div>
                : view === 'single' && active ? <div className="single-view"><div className="single-photo"><img src={active.previewUrl} alt={active.fileName} /><button className="single-expand icon-button" aria-label="全屏查看照片" onClick={() => setModal('preview')}><Maximize2 size={18} /></button></div><div className="single-navigation"><button className="button secondary" disabled={activeIndex <= 0} onClick={() => navigate(-1)}><ChevronLeft size={16} />上一张</button><span>{active.fileName}<small>{activeIndex + 1} / {filtered.length}</small></span><button className="button secondary" disabled={activeIndex >= filtered.length - 1} onClick={() => navigate(1)}>下一张<ChevronRight size={16} /></button></div><div className="filmstrip">{filtered.slice(Math.max(0, activeIndex - 4), activeIndex + 6).map((photo) => <button key={photo.id} className={photo.id === activeId ? 'active' : ''} onClick={() => setActiveId(photo.id)} aria-label={`查看 ${photo.fileName}`}><img src={photo.thumbnailUrl} alt={photo.fileName} /></button>)}</div></div>
                  : <>{visibleGroups.map(([key, group], index) => <section className="photo-group" key={key || 'all'}>{key && <div className="group-heading"><div>{category === 'similar' ? <><Copy size={13} /><strong>连拍组 {String(index + 1).padStart(2, '0')}</strong></> : <><Clock3 size={13} /><strong>{key}</strong></>}<span>{category === 'similar' ? photos.filter((photo) => photo.similarGroupId === key).length : group.length} 张</span></div>{category === 'similar' ? <button onClick={() => openCompare(key)}>并排对比<SplitSquareHorizontal size={13} /></button> : <span className="group-line" />}</div>}<div className="photo-grid">{group.map(photoCard)}</div></section>)}<div ref={sentinelRef} className="load-more">{visibleCount < filtered.length ? <button className="button secondary" onClick={() => setVisibleCount((value) => value + 60)}>继续加载照片（{Math.min(visibleCount, filtered.length)} / {filtered.length}）</button> : <span>每一帧，都是热爱的证明。<span className="end-dot" /></span>}</div></>}
        </div>
      </main>

      <aside className="details-panel"><div className="details-heading"><h2>照片详情</h2><span>{active ? String(activeIndex + 1).padStart(2, '0') : '—'} <span>/ {filtered.length}</span></span></div>{active ? <>
        <div className="detail-preview"><img src={active.thumbnailUrl} alt={`${active.fileName} 预览`} /><button className="icon-button" aria-label="放大当前照片" onClick={() => setModal('preview')}><Maximize2 size={15} /></button><span className={`detail-decision ${active.decision}`}>{active.decision === 'keep' ? '已保留' : active.decision === 'reject' ? '已淘汰' : '待筛选'}</span></div>
        <div className="detail-file"><h3 title={active.fileName}>{active.fileName}</h3><button className="icon-button" title="在文件夹中显示" aria-label="在文件夹中显示当前照片" disabled={Boolean(busy)} onClick={() => void runTask('正在打开文件位置', () => api.showInFolder(active.id))}><FolderOpen size={16} /></button></div><div className="detail-file-meta">{active.width} × {active.height}<span>·</span>{readableBytes(active.bytes)}<span>·</span>{active.fileName.split('.').pop()?.toUpperCase()}</div>
        <div className="decision-buttons"><button className={`keep-action ${active.decision === 'keep' ? 'is-on' : ''}`} disabled={Boolean(busy)} onClick={() => void applyPatch([active.id], { decision: 'keep' }, '标记保留', true)}><Check size={16} />保留<kbd>K</kbd></button><button className={`reject-action ${active.decision === 'reject' ? 'is-on' : ''}`} disabled={Boolean(busy)} onClick={() => void applyPatch([active.id], { decision: 'reject' }, '标记淘汰', true)}><X size={16} />淘汰<kbd>J</kbd></button></div>
        <div className="rating-row"><span>照片评级</span><Rating value={active.rating} disabled={Boolean(busy)} onChange={(value) => void applyPatch([active.id], { rating: value }, `更新星级`)} /></div>
        <section className="detail-section"><div className="section-heading"><h3><ScanText size={14} />号码布</h3><span>{active.ocrStatus === 'pending' ? '待识别' : active.ocrStatus === 'error' ? '识别异常' : '可手动校正'}</span></div><div className="tags-list">{active.bibNumbers.length ? active.bibNumbers.map((bib) => <span className="bib-tag" key={bib}><span>#</span>{bib}<button aria-label={`移除号码 ${bib}`} disabled={Boolean(busy)} onClick={() => changeTag('bibNumbers', bib, true)}><X size={11} /></button></span>) : <span className="muted-text">还没有号码布信息</span>}</div><form className="tag-form" onSubmit={(event) => { event.preventDefault(); changeTag('bibNumbers', bibDraft); }}><input aria-label="添加或校正号码布" placeholder="输入号码，回车添加" value={bibDraft} onChange={(event) => setBibDraft(event.target.value)} /><button type="submit" aria-label="添加号码布" disabled={Boolean(busy) || !bibDraft.trim()}><Plus size={14} /></button></form>{active.ocrStatus === 'error' && <p className="field-hint error-text">识别未完成，可手动输入或重新识别。</p>}</section>
        <section className="detail-section"><div className="section-heading"><h3><Tag size={14} />人物标签</h3><span>方便归档与检索</span></div><div className="tags-list">{active.athleteTags.length ? active.athleteTags.map((tag) => <span className="person-tag" key={tag}>{tag}<button aria-label={`移除标签 ${tag}`} disabled={Boolean(busy)} onClick={() => changeTag('athleteTags', tag, true)}><X size={11} /></button></span>) : <span className="muted-text">为运动员添加一个名字</span>}</div><form className="tag-form" onSubmit={(event) => { event.preventDefault(); changeTag('athleteTags', tagDraft); }}><input aria-label="添加人物标签" placeholder="添加姓名或团队名称" value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} /><button type="submit" aria-label="添加人物标签" disabled={Boolean(busy) || !tagDraft.trim()}><Plus size={14} /></button></form></section>
        <section className="detail-section quality-section"><div className="section-heading"><h3><Focus size={14} />画面分析</h3><span className={active.isBlurry ? 'warm-text' : 'lime-text'}>{active.isBlurry ? '建议复核' : '画面清晰'}</span></div><div className="quality-line"><span>清晰度评分</span><strong>{Math.round(active.sharpness)}<small>分</small></strong></div><div className="quality-meter"><span className={active.isBlurry ? 'low' : ''} style={{ width: `${Math.min(100, Math.max(4, active.sharpness / 2))}%` }} /></div>{similarPhotos.length > 1 && <button className="similar-detail" onClick={() => openCompare(active.similarGroupId)}><span><Copy size={14} />发现 {similarPhotos.length - 1} 张相似照片</span><ArrowUpRight size={14} /></button>}</section>
        <section className="detail-section capture-section"><button className="section-heading section-heading-button" onClick={() => setInfoExpanded((value) => !value)}><h3><Camera size={14} />拍摄信息</h3><ChevronDown size={14} className={infoExpanded ? 'rotated' : ''} /></button><div className="capture-date"><Clock3 size={12} />{localDate(active.capturedAt)}</div>{infoExpanded && <div className="extra-info"><div><span>时间来源</span><span>{active.timeSource === 'exif' ? '照片 EXIF' : '文件时间'}</span></div><div><span>文件大小</span><span>{readableBytes(active.bytes)}</span></div><div><span>相对路径</span><span title={active.relativePath}>{active.relativePath}</span></div><p>清晰度与相似度为辅助建议，请结合画面判断。</p></div>}</section>
        <button className="skip-button" disabled={Boolean(busy) || activeIndex >= filtered.length - 1} onClick={() => navigate(1)}><SkipForward size={13} />先跳过，看看下一张<kbd>U</kbd></button>
      </> : <div className="details-empty"><ImageIcon size={32} strokeWidth={1} /><p>选择一张照片<br />查看详情并开始筛选</p></div>}</aside></div>

      <footer className="statusbar">{busy ? <div className="operation-progress"><LoaderCircle size={13} className="spinning" /><span>{progress?.message || busy}</span>{progress && <><div className="footer-progress"><span style={{ width: `${progressPercent}%` }} /></div><span>{progress.current} / {progress.total}</span></>}{progress && <button disabled={cancelRequested} onClick={() => void cancelOperation()}>{cancelRequested ? '取消中…' : '取消'}</button>}</div> : <><div className="status-left"><span className="status-dot" /><span>所有更改已保存</span>{isDemo && <span className="footer-demo">演示相册 · 本地照片请使用 Windows 客户端</span>}{operationErrors.length > 0 && <button className="error-details-button" onClick={() => setModal('errors')}><AlertCircle size={12} />{operationErrors.length} 项需查看</button>}</div><div className="shortcut-hints"><span><kbd>J</kbd>淘汰</span><span><kbd>K</kbd>保留</span><span><kbd>空格</kbd>大图</span><button onClick={() => setModal('help')}><Keyboard size={14} /></button></div></>}<button className="undo-button" disabled={!undoEntries.length || Boolean(busy)} onClick={() => void undo()} title="撤销最近一次操作（Z）"><Undo2 size={13} />撤销<kbd>Z</kbd></button></footer>
    </div>

    {notice && <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'success' ? <CheckCircle2 size={18} /> : notice.kind === 'error' ? <AlertCircle size={18} /> : <Info size={18} />}<span>{notice.message}</span><button aria-label="关闭通知" onClick={() => setNotice(null)}><X size={15} /></button></div>}

    {modal === 'analysis' && <ModalFrame title="让精彩更快浮现" subtitle="在本机分析照片，先整理，再由你决定。" onClose={closeModal}><div className="analysis-intro"><span className="analysis-glyph">✧</span><div><strong>找出相似连拍，提醒可能模糊</strong><p>分析不会删除照片，也不会改变你的筛选结果。</p></div></div><div className="slider-setting"><label htmlFor="blur-threshold">模糊判断阈值<strong>{analysis.blurThreshold}</strong></label><p>清晰度低于此值将标记为「可能模糊」。运动画面可适当调低。</p><input id="blur-threshold" type="range" min="10" max="200" step="5" value={analysis.blurThreshold} onChange={(event) => setAnalysis((value) => ({ ...value, blurThreshold: Number(event.target.value) }))} /><div className="range-captions"><span>宽松 · 10</span><span>严格 · 200</span></div></div><div className="slider-setting"><label htmlFor="similarity-threshold">相似照片容差<strong>{analysis.similarityDistance}</strong></label><p>数值越大，越容易将构图接近的照片归为一组。</p><input id="similarity-threshold" type="range" min="1" max="20" value={analysis.similarityDistance} onChange={(event) => setAnalysis((value) => ({ ...value, similarityDistance: Number(event.target.value) }))} /><div className="range-captions"><span>更相似 · 1</span><span>更宽泛 · 20</span></div></div><div className="modal-note"><ShieldCheck size={15} />原始照片始终保留。号码布识别可通过顶部按钮单独运行。</div><div className="modal-footer"><button className="text-button" onClick={() => setAnalysis(DEFAULT_ANALYSIS)}>恢复默认</button><div><button className="button secondary" onClick={closeModal}>稍后再说</button><button className="button primary" disabled={Boolean(busy) || !photos.length} onClick={runAnalysis}><Focus size={15} />分析 {photos.length.toLocaleString()} 张照片</button></div></div></ModalFrame>}

    {modal === 'export' && <ModalFrame title="把精彩带走" subtitle="复制原始照片到你选择的文件夹，原文件保持完整。" onClose={closeModal}><div className="export-scope"><button className={exportMode === 'keep' ? 'active' : ''} onClick={() => setExportMode('keep')}><CheckCircle2 size={20} /><strong>已保留的照片</strong><span>{stats.keep} 张</span><span className="radio-circle">{exportMode === 'keep' && <span />}</span></button><button className={exportMode === 'selected' ? 'active' : ''} onClick={() => setExportMode('selected')}><Grid2X2 size={20} /><strong>当前选中的照片</strong><span>{selected.size} 张</span><span className="radio-circle">{exportMode === 'selected' && <span />}</span></button></div><label className="field-label" htmlFor="export-group">文件夹整理方式</label><select className="full-select" id="export-group" value={exportGroup} onChange={(event) => setExportGroup(event.target.value as typeof exportGroup)}><option value="athlete">按运动员 · 号码布 / 人物标签</option><option value="time">按拍摄日期</option><option value="none">全部放在同一文件夹</option></select><p className="field-hint">{exportGroup === 'athlete' ? '优先按人物标签归档，未填写时按号码布。多人照片会复制到对应的每个文件夹；未标记照片会单独整理。' : exportGroup === 'time' ? '使用照片拍摄日期建立文件夹，方便按赛事日期交付。' : '保留原始画质与文件名；重名文件会自动处理。'}</p><div className="export-summary"><FileImage size={24} /><div><strong>{exportIds.length.toLocaleString()}<span> 张照片准备就绪</span></strong><p>下一步选择保存位置</p></div><FolderOutput size={20} /></div>{exportIds.length === 0 && <p className="empty-export-note">{exportMode === 'keep' ? '先将喜欢的照片标记为保留。' : '先在照片网格中勾选需要导出的照片。'}</p>}<div className="modal-footer"><span className="subtle-label">本地复制 · 原画质</span><div><button className="button secondary" onClick={closeModal}>取消</button><button className="button primary" disabled={Boolean(busy) || exportIds.length === 0} onClick={exportPhotos}><FolderOutput size={15} />选择位置并导出</button></div></div></ModalFrame>}

    {modal === 'time' && <ModalFrame title="按拍摄时间筛选" subtitle="缩小到某一段比赛，找到你记得的瞬间。" onClose={closeModal}><label className="field-label" htmlFor="time-from">开始时间</label><input className="full-input" id="time-from" type="datetime-local" value={timeDraft.from} onChange={(event) => setTimeDraft((value) => ({ ...value, from: event.target.value }))} /><label className="field-label" htmlFor="time-to">结束时间</label><input className="full-input" id="time-to" type="datetime-local" value={timeDraft.to} onChange={(event) => setTimeDraft((value) => ({ ...value, to: event.target.value }))} />{timeDraft.from && timeDraft.to && timeDraft.from > timeDraft.to && <p className="error-text field-hint">结束时间需晚于开始时间。</p>}<p className="field-hint">留空表示不限。优先使用照片拍摄时间，无拍摄信息时使用文件时间。</p><div className="modal-footer"><button className="text-button" onClick={() => { setTimeDraft({ from: '', to: '' }); setTimeFrom(''); setTimeTo(''); closeModal(); }}>清除时间范围</button><div><button className="button secondary" onClick={closeModal}>取消</button><button className="button primary" disabled={Boolean(timeDraft.from && timeDraft.to && timeDraft.from > timeDraft.to)} onClick={() => { setTimeFrom(timeDraft.from); setTimeTo(timeDraft.to); closeModal(); }}>应用筛选</button></div></div></ModalFrame>}

    {modal === 'help' && <ModalFrame title="专注看照片，其余交给快捷键" subtitle="点击任意照片开始。输入文字或打开弹窗时，快捷键会暂停。" onClose={closeModal}><div className="help-shortcuts">{[['保留当前照片，并前进', 'K / →'], ['淘汰当前照片，并前进', 'J / ←'], ['暂时跳过', 'U'], ['上一张 / 下一张', '↑ ↓ / A D'], ['查看大图', '空格'], ['设置星级', '1 – 5'], ['撤销最近一组操作', 'Z'], ['关闭弹窗', 'Esc']].map(([name, key]) => <div key={name}><span>{name}</span><kbd>{key}</kbd></div>)}</div><div className="help-workflow"><h3>从 2000 张到你的精选</h3><p>① 导入照片文件夹　② 智能分析与号码布识别<br />③ 快捷键挑选或并排比较　④ 按运动员归档导出</p><p>支持照片：JPEG、PNG、WebP、TIFF。相似与模糊提醒辅助判断，不会自动淘汰照片。所有处理在本机完成。</p></div><div className="modal-footer"><span className="subtle-label">SprintSelect · 为每一份热爱而选</span><button className="button primary" onClick={closeModal}>开始选片 <ArrowRight size={15} /></button></div></ModalFrame>}

    {modal === 'errors' && <ModalFrame title="需要查看的文件" subtitle={`${operationErrors.length} 个文件未完成处理，其他照片不受影响。`} onClose={closeModal}><div className="error-list">{operationErrors.map((error, index) => <div key={`${error.path}-${index}`}><AlertCircle size={16} /><div><strong>{error.path}</strong><p>{error.message}</p></div></div>)}</div><div className="modal-footer"><span className="subtle-label">可检查文件后重新导入或重试</span><button className="button primary" onClick={closeModal}>知道了</button></div></ModalFrame>}

    {modal === 'compare' && <ModalFrame wide title="好照片，值得放在一起看" subtitle={`${comparedPhotos.length} 张相似照片 · 独立标记去留，保留你喜欢的每一个瞬间。`} onClose={closeModal}><div className="compare-grid">{comparedPhotos.map((photo) => <article key={photo.id} className={photo.decision === 'keep' ? 'compare-photo chosen' : 'compare-photo'}><div className="compare-image"><img src={photo.previewUrl} alt={photo.fileName} /><span className={`compare-quality ${photo.isBlurry ? 'warm-text' : ''}`}><Focus size={12} />清晰度 {Math.round(photo.sharpness)}</span>{photo.decision !== 'unreviewed' && <span className={`image-badge ${photo.decision === 'keep' ? 'keep-badge' : 'reject-badge'}`}>{photo.decision === 'keep' ? <Check size={12} /> : <X size={12} />}{photo.decision === 'keep' ? '已保留' : '已淘汰'}</span>}</div><div className="compare-caption"><strong>{photo.fileName}</strong><span>{localDate(photo.capturedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div><div className="compare-actions"><button disabled={Boolean(busy)} className={photo.decision === 'keep' ? 'active-keep' : ''} onClick={() => void applyPatch([photo.id], { decision: 'keep' }, '保留对比照片')}><Check size={14} />保留</button><button disabled={Boolean(busy)} className={photo.decision === 'reject' ? 'active-reject' : ''} onClick={() => void applyPatch([photo.id], { decision: 'reject' }, '淘汰对比照片')}><X size={14} />淘汰</button><button disabled={Boolean(busy) || photo.decision === 'unreviewed'} title="重置为待筛选" aria-label={`重置 ${photo.fileName} 为待筛选`} onClick={() => void applyPatch([photo.id], { decision: 'unreviewed' }, '重置对比照片')}><Undo2 size={13} /></button></div></article>)}</div><div className="modal-footer"><span className="subtle-label"><Info size={13} />同组照片可以保留多张</span><div><button className="button secondary" disabled={!undoEntries.length || Boolean(busy)} onClick={() => void undo()}><Undo2 size={14} />撤销</button><button className="button primary" onClick={closeModal}>完成比较 <Check size={14} /></button></div></div></ModalFrame>}

    {modal === 'preview' && active && <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label="照片大图" onClick={(event) => { if (event.target === event.currentTarget) closeModal(); }}><PreviewKeyHandler onClose={closeModal} /><div className="preview-top"><div><strong>{active.fileName}</strong><span>{activeIndex + 1} / {filtered.length}</span></div><button className="icon-button" aria-label="关闭照片大图" autoFocus onClick={closeModal}><X size={23} /></button></div><div className="preview-body"><button className="preview-arrow" disabled={activeIndex <= 0} aria-label="上一张照片" onClick={() => navigate(-1)}><ChevronLeft size={25} /></button><img src={active.previewUrl} alt={active.fileName} /><button className="preview-arrow" disabled={activeIndex >= filtered.length - 1} aria-label="下一张照片" onClick={() => navigate(1)}><ChevronRight size={25} /></button></div><div className="preview-bottom"><span className="preview-meta">{active.width} × {active.height}<span>·</span>{localDate(active.capturedAt)}</span><div className="preview-decisions"><button disabled={Boolean(busy)} className={`button ${active.decision === 'reject' ? 'reject-action' : 'secondary'}`} onClick={() => void applyPatch([active.id], { decision: 'reject' }, '标记淘汰', true)}><X size={16} />淘汰</button><button disabled={Boolean(busy)} className="button primary" onClick={() => void applyPatch([active.id], { decision: 'keep' }, '标记保留', true)}><Check size={16} />保留并继续</button></div><Rating value={active.rating} disabled={Boolean(busy)} onChange={(value) => void applyPatch([active.id], { rating: value }, '更新星级')} /></div></div>}
  </div>;
}

function PreviewKeyHandler({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === 'Escape' || (event.key === ' ' && !target.closest('button, input, select, textarea'))) { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const controls = [...document.querySelectorAll<HTMLElement>('.preview-backdrop button:not(:disabled)')];
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
  return null;
}

function ImagesIcon() {
  return <div className="empty-image-stack"><div /><div /><div><Camera size={39} strokeWidth={1.1} /></div></div>;
}
