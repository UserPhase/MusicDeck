import fs from "node:fs";
import { cleanupTemporaryDirectory } from "./temporaryDirectory.js";
import path from "node:path";
import { DefaultProcessRunner, type ProcessRunner } from "../../domain/process-runner.js";
import { autoDetectFFmpegPath } from "../../domain/spotdl-downloader-adapter.js";
import { flushFile, flushDirectory, safeMusicPath } from "./safeMusicPath.js";

export type CanonicalAudioMetadata = {
  title: string; artists: string[]; album: string; albumArtist?: string | null;
  year?: string | number | null; isrc?: string | null; artworkUrl?: string | null;
};
export type AudioTagInspection = {
  artist: string | null; albumArtist: string | null; title: string | null;
  album: string | null; year: string | null; isrc: string | null; hasArtwork: boolean;
};
export type MediaToolPaths = { ffmpegPath: string; ffprobePath?: string; pythonPath?: string };
export type AudioTaggerOptions = Partial<MediaToolPaths> & {
  /** Read runtime plugin settings for every operation, including reconfiguration. */
  getTools?: () => MediaToolPaths;
  processRunner?: ProcessRunner; fetchImpl?: typeof fetch;
};
const clean = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const normalized = (value: string) => value.normalize("NFKC").trim().toLowerCase();
const year = (value: unknown): string | null => String(value ?? "").match(/\b\d{4}\b/)?.[0] || null;
export function isInvalidArtist(value: string | null | undefined): boolean {
  return !value?.trim() || /unknown/i.test(value) || /^various\s+artists?$/i.test(value.trim());
}
function matches(actual: string | null, expected: string | null): boolean {
  return Boolean(actual?.trim()) && (!expected || normalized(actual!) === normalized(expected));
}
export function needsMetadataRepair(tags: AudioTagInspection, expected: CanonicalAudioMetadata): boolean {
  const artists = expected.artists.map((artist) => artist.trim()).filter(Boolean);
  const actualArtists = (tags.artist || "").split(/\s*;\s*|\s+\/\s+/).filter(Boolean).map(normalized);
  return isInvalidArtist(tags.artist)
    || artists.some((artist) => !actualArtists.includes(normalized(artist)))
    || !matches(tags.title, clean(expected.title)) || !matches(tags.album, clean(expected.album))
    || !matches(tags.albumArtist, clean(expected.albumArtist) || artists[0] || null)
    || /unknown/i.test(tags.albumArtist || "")
    || !matches(year(tags.year), year(expected.year))
    || (Boolean(expected.isrc) && !matches(tags.isrc, clean(expected.isrc))) || !tags.hasArtwork;
}

/** spotDL installs Mutagen already; inspection must not require a separate ffprobe install. */
export const NATIVE_TAG_INSPECT = String.raw`
import sys, json
from mutagen import File
from mutagen.id3 import ID3
filename = sys.argv[1]
audio = File(filename)
if audio is None: raise RuntimeError('Unsupported or invalid audio file')
tags = audio.tags or {}
def value(*keys):
    for key in keys:
        try: item = tags.get(key)
        except (KeyError, ValueError): continue
        if item is None: continue
        item = getattr(item, 'text', item)
        if not isinstance(item, (list, tuple)): item = [item]
        values = [v.decode('utf-8', 'replace') if isinstance(v, bytes) else str(v) for v in item]
        result = '; '.join(v.strip() for v in values if v.strip())
        if result: return result
    return None
pictures = bool(getattr(audio, 'pictures', None)) or bool(tags.get('covr')) or bool(tags.get('metadata_block_picture'))
if isinstance(tags, ID3): pictures = bool(tags.getall('APIC'))
print(json.dumps({
    'artist': value('TPE1', '\xa9ART', 'artist'),
    'albumArtist': value('TPE2', 'aART', 'albumartist', 'album_artist'),
    'title': value('TIT2', '\xa9nam', 'title'),
    'album': value('TALB', '\xa9alb', 'album'),
    'year': value('TDRC', 'TYER', '\xa9day', 'date', 'year'),
    'isrc': value('TSRC', '----:com.apple.iTunes:ISRC', '----:spotdl:ISRC', 'isrc'),
    'hasArtwork': pictures
}))
`;

/** Native edits preserve arbitrary frames/atoms/comments and original audio bytes.
 * Mutagen runs inside spotDL's Python environment. Its absence fails safely.
 * Untouched fields and pictures are compared after saving before publication.
 */
export const NATIVE_TAG_MERGE = String.raw`
import sys, json, copy, hashlib
from mutagen import File
from mutagen.id3 import ID3, ID3NoHeaderError, TIT2, TPE1, TPE2, TALB, TDRC, TSRC, APIC
from mutagen.flac import Picture
from mutagen.mp4 import MP4Cover
filename, payload, cover = sys.argv[1:4]
m = json.loads(payload)
ext = filename.rsplit('.', 1)[-1].lower()
if ext == 'mp3':
    try: tags = ID3(filename, translate=False)
    except ID3NoHeaderError: tags = ID3()
    version = tags.version[1] if tags.version[1] in (3, 4) else 4
    edited = {'TIT2', 'TPE1', 'TPE2', 'TALB'}
    if m.get('year'): edited.add('TDRC'); edited.add('TYER')
    if m.get('isrc'): edited.add('TSRC')
    def snapshot(t):
        result = {k: (v.pprint(), hashlib.sha256(v.data).hexdigest() if hasattr(v, 'data') else None)
                  for k,v in t.items() if k.split(':')[0] not in edited}
        result['__unknown_frames__'] = [hashlib.sha256(v).hexdigest() for v in t.unknown_frames]
        return result
    before = snapshot(tags)
    for name, cls, value in [('TIT2', TIT2, m['title']), ('TPE1', TPE1, m['artists']),
                             ('TPE2', TPE2, m['albumArtist']), ('TALB', TALB, m['album']),
                             ('TDRC', TDRC, m.get('year')), ('TSRC', TSRC, m.get('isrc'))]:
        if value:
            tags.delall(name)
            if name == 'TDRC': tags.delall('TYER')
            tags.add(cls(encoding=3, text=[value]))
    added_cover = bool(cover and not tags.getall('APIC'))
    if added_cover:
        with open(cover, 'rb') as f: data = f.read()
        tags.add(APIC(encoding=3, mime=m['coverMime'], type=3, desc='Cover', data=data))
    tags.save(filename, v2_version=version, v23_sep='; ')
    after = snapshot(ID3(filename, translate=False))
    if added_cover: after = {k:v for k,v in after.items() if not k.startswith('APIC:')}
    if before != after: raise RuntimeError('An unrelated ID3 frame changed during repair')
else:
    audio = File(filename)
    if audio is None: raise RuntimeError('Unsupported audio container')
    if audio.tags is None: audio.add_tags()
    mp4 = ext in ('m4a', 'mp4')
    names = {'title':'\xa9nam', 'artists':'\xa9ART', 'albumArtist':'aART', 'album':'\xa9alb',
             'year':'\xa9day', 'isrc':'----:com.apple.iTunes:ISRC'} if mp4 else {
             'title':'title', 'artists':'artist', 'albumArtist':'albumartist', 'album':'album', 'year':'date', 'isrc':'isrc'}
    edited = {names[k].lower() for k,v in m.items() if k in names and v}
    def snapshot(a): return {k:copy.deepcopy(v) for k,v in a.tags.items() if k.lower() not in edited}
    before = snapshot(audio)
    pictures = [p.write() for p in getattr(audio, 'pictures', [])]
    for key, tag in names.items():
        if m.get(key):
            value = m[key].encode('utf-8') if mp4 and key == 'isrc' else m[key]
            audio.tags[tag] = [value]
    added_cover = False
    if cover:
        with open(cover, 'rb') as f: data = f.read()
        if mp4 and not audio.tags.get('covr'):
            audio.tags['covr'] = [MP4Cover(data, imageformat=MP4Cover.FORMAT_PNG if m['coverMime'] == 'image/png' else MP4Cover.FORMAT_JPEG)]
            added_cover = True
        elif ext == 'flac' and not audio.pictures:
            p = Picture(); p.data = data; p.type = 3; p.mime = m['coverMime']; audio.add_picture(p)
    audio.save()
    reread = File(filename)
    after = snapshot(reread)
    if added_cover: after.pop('covr', None)
    if before != after: raise RuntimeError('An unrelated metadata field changed during repair')
    if pictures and pictures != [p.write() for p in getattr(reread, 'pictures', [])]:
        raise RuntimeError('Embedded artwork changed during repair')
`;

export class AudioTaggerService {
  private readonly runner: ProcessRunner;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: AudioTaggerOptions = {}) {
    this.runner = options.processRunner || new DefaultProcessRunner(); this.fetchImpl = options.fetchImpl || fetch;
  }
  private tools() {
    const tools = this.options.getTools?.() || this.options;
    const ffmpeg = tools.ffmpegPath || autoDetectFFmpegPath();
    return { ffprobe: tools.ffprobePath || path.join(path.dirname(ffmpeg), `ffprobe${path.extname(ffmpeg)}`),
      python: tools.pythonPath || (process.platform === "win32" ? "python" : "python3") };
  }
  async inspect(filePath: string): Promise<AudioTagInspection> {
    let result;
    try {
      result = await this.runner.run(this.tools().ffprobe, ["-v", "error", "-show_entries",
        "format_tags:stream=codec_type:stream_disposition=attached_pic", "-of", "json", filePath], { timeoutMs: 15_000 }).promise;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.inspectNative(filePath);
    }
    if (result.exitCode !== 0) throw new Error(`Could not inspect audio metadata: ${result.stderr.trim() || "ffprobe failed"}`);
    const parsed = JSON.parse(result.stdout) as { format?: { tags?: Record<string, unknown> }; streams?: Array<{ disposition?: { attached_pic?: number } }> };
    const tags = Object.fromEntries(Object.entries(parsed.format?.tags || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const value = (...keys: string[]) => keys.map((key) => clean(tags[key.toLowerCase()])).find(Boolean) || null;
    return { artist: value("artist", "TPE1"), albumArtist: value("album_artist", "albumartist", "TPE2"),
      title: value("title", "TIT2"), album: value("album", "TALB"), year: value("date", "year", "TDRC", "TYER"),
      isrc: value("isrc", "TSRC", "----:com.apple.iTunes:ISRC"),
      hasArtwork: Boolean(parsed.streams?.some((stream) => stream.disposition?.attached_pic === 1)) };
  }
  private async inspectNative(filePath: string): Promise<AudioTagInspection> {
    const python = this.tools().python;
    let result;
    try {
      result = await this.runner.run(python, ["-c", NATIVE_TAG_INSPECT, filePath], { timeoutMs: 15_000 }).promise;
    } catch (error) {
      throw new Error(`Audio metadata inspection could not start ${python}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (result.exitCode !== 0) throw new Error(`Could not inspect audio with spotDL's Python (${python}): ${result.stderr.trim() || "Mutagen failed"}`);
    const inspection = JSON.parse(result.stdout) as AudioTagInspection;
    if (typeof inspection.hasArtwork !== "boolean") throw new Error("Native audio metadata inspector returned invalid data");
    return inspection;
  }
  async verifyAndTag(filePath: string, metadata: CanonicalAudioMetadata, rootDirectory?: string): Promise<{ repaired: boolean; inspection: AudioTagInspection }> {
    if (rootDirectory) safeMusicPath(rootDirectory, filePath);
    const physical = fs.realpathSync(filePath);
    if (rootDirectory) safeMusicPath(fs.realpathSync(rootDirectory), physical);
    const inspection = await this.inspect(physical);
    if (!needsMetadataRepair(inspection, metadata)) return { repaired: false, inspection };
    const artists = metadata.artists.map((artist) => artist.trim()).filter(Boolean);
    if (!artists.length || !metadata.title.trim() || !metadata.album.trim()) throw new Error("Canonical track metadata is incomplete");
    const directory = fs.mkdtempSync(path.join(path.dirname(physical), ".musicdeck-tag-"));
    const temporary = path.join(directory, path.basename(physical));
    try {
      fs.copyFileSync(physical, temporary, fs.constants.COPYFILE_EXCL);
      const coverPath = path.join(directory, "cover");
      const coverMime = !inspection.hasArtwork && metadata.artworkUrl ? await this.downloadArtwork(metadata.artworkUrl, coverPath) : null;
      const payload = { title: metadata.title.trim(), artists: [...new Set(artists)].join("; "),
        album: metadata.album.trim(), albumArtist: clean(metadata.albumArtist) || artists[0],
        year: year(metadata.year), isrc: clean(metadata.isrc), coverMime };
      const result = await this.runner.run(this.tools().python, ["-c", NATIVE_TAG_MERGE, temporary,
        JSON.stringify(payload), coverMime ? coverPath : ""], { timeoutMs: 120_000 }).promise;
      if (result.exitCode !== 0) throw new Error(`Could not merge audio metadata: ${result.stderr.trim() || "Mutagen failed"}`);
      const verified = await this.inspect(temporary);
      if (needsMetadataRepair(verified, metadata)) throw new Error("Repaired audio failed post-write metadata verification");
      flushFile(temporary); fs.chmodSync(temporary, fs.statSync(physical).mode);
      if (rootDirectory) safeMusicPath(fs.realpathSync(rootDirectory), physical);
      fs.renameSync(temporary, physical);
      flushDirectory(path.dirname(physical));
      return { repaired: true, inspection: verified };
    } finally { await cleanupTemporaryDirectory(directory); }
  }
  private async downloadArtwork(url: string, destination: string): Promise<string> {
    const source = new URL(url);
    const allowed = source.hostname === "i.scdn.co" || source.hostname.endsWith(".dzcdn.net")
      || /(^|\.)mzstatic\.com$/.test(source.hostname);
    if (source.protocol !== "https:" || !allowed || source.username || source.password || source.port) throw new Error("Untrusted artwork URL");
    const response = await this.fetchImpl(source, { signal: AbortSignal.timeout(8000), redirect: "error" });
    const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (!response.ok || !mime || !["image/png", "image/jpeg"].includes(mime) || !response.body) throw new Error("Artwork unavailable");
    const chunks: Buffer[] = []; const reader = response.body.getReader(); let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length;
        if (length > 8 * 1024 * 1024) throw new Error("Artwork exceeds size limit");
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel(); }
    if (!length) throw new Error("Artwork is empty");
    fs.writeFileSync(destination, Buffer.concat(chunks), { flag: "wx", mode: 0o600 }); return mime;
  }
}
