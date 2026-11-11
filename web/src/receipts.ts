// Prepares a receipt in the browser before upload: photos are shrunk and saved as
// JPEG (phone photos are often 5–10 MB; a receipt reads fine at 2000 pixels), and a
// small preview is made. PDFs are sent as they are.
import { post } from './api';

const MAX_SIDE = 2000;
const THUMB_SIDE = 360;
const MAX_PDF = 10 * 1024 * 1024;

export interface Receipt {
  id: number;
  fileName: string | null;
  mime: string;
  hasThumb: boolean;
  status: 'pending' | 'reading' | 'read' | 'failed';
  readError: string | null;
  vendor: string | null;
  date: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  tip: number | null;
  total: number | null;
  cardLast4: string | null;
  paymentMethod: string | null;
  category: string | null;
  items: { description: string; quantity: number | null; unitPrice: number | null; amount: number | null }[];
  confidence: 'high' | 'medium' | 'low' | null;
  readerNotes: string | null;
  note: string | null;
  checked: boolean;
  transactionId: number | null;
  matchSource: 'auto' | 'user' | null;
  transaction: { id: number; posted: string; amount: number; payee: string | null; description: string; account: string } | null;
  createdAt: string;
}

export interface Suggestion {
  id: number;
  posted: string;
  amount: number;
  payee: string;
  account: string;
  exact: boolean;
  vendorMatch: boolean;
  cardMatch: boolean;
  days: number;
  score: number;
}

const toBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

async function sha256(buffer: ArrayBuffer): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null; // only over HTTPS; the server works it out instead
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function jpeg(bitmap: ImageBitmap, maxSide: number, quality: number): Promise<ArrayBuffer> {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot prepare photos.');
  context.fillStyle = '#fff'; // transparent screenshots get a white background
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('This browser cannot prepare photos.');
  return blob.arrayBuffer();
}

export async function uploadReceipt(file: File): Promise<{ id: number; duplicate: boolean }> {
  const original = await file.arrayBuffer();
  const originalHash = await sha256(original);
  let data: ArrayBuffer;
  let thumb: ArrayBuffer | null = null;
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    if (file.size > MAX_PDF) throw new Error(`${file.name} is larger than 10 MB.`);
    data = original;
  } else {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error(
        `${file.name} can't be opened in this browser${/\.hei[cf]$/i.test(file.name) ? ' (HEIC photos open in Safari; elsewhere, export it as JPEG)' : ''}.`
      );
    }
    data = await jpeg(bitmap, MAX_SIDE, 0.85);
    thumb = await jpeg(bitmap, THUMB_SIDE, 0.7);
    bitmap.close();
  }
  return post('/api/receipts', { fileName: file.name, originalHash, data: toBase64(data), thumb: thumb ? toBase64(thumb) : null });
}

export const STATUS_LABELS: Record<string, string> = {
  pending: 'Waiting to be read',
  reading: 'Reading…',
  read: 'Read',
  failed: "Couldn't be read",
};
