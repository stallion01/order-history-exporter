// Reads a receipt photo or PDF with Claude and returns its details as checked JSON.
// Only the receipt itself and the category names are sent; nothing else from the books.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

export const READER_MODEL = 'claude-opus-5-5';

const ReceiptSchema = z.object({
  is_receipt: z.boolean().describe('False if the image is not a receipt, invoice or bill.'),
  vendor: z.string().nullable().describe('The business name, as a person would write it, e.g. "Home Depot".'),
  date: z.string().nullable().describe('Purchase date as YYYY-MM-DD.'),
  currency: z.string().nullable().describe('ISO 4217 code, e.g. USD.'),
  subtotal: z.number().nullable(),
  tax: z.number().nullable(),
  tip: z.number().nullable(),
  total: z.number().nullable().describe('The amount actually paid, including tax and tip.'),
  card_last4: z.string().nullable().describe('Last four digits of the card used, if printed.'),
  payment_method: z.string().nullable().describe('e.g. "Visa", "Amex", "Cash", "Debit".'),
  category: z.string().nullable().describe('One of the listed categories, or null if none fits.'),
  category_confidence: z
    .enum(['high', 'medium', 'low'])
    .describe('How sure you are of the category: high only when the vendor and items leave no real doubt which listed category it is.'),
  items: z.array(
    z.object({
      description: z.string(),
      quantity: z.number().nullable(),
      unit_price: z.number().nullable(),
      amount: z.number().nullable(),
    })
  ),
  confidence: z.enum(['high', 'medium', 'low']).describe('How sure you are of the total and date.'),
  notes: z.string().nullable().describe('Anything a bookkeeper should know, e.g. a faded or cut-off total.'),
});

export type ReceiptReading = z.infer<typeof ReceiptSchema>;

export interface ReadResult {
  reading: ReceiptReading;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export type ReceiptReader = (file: { data: Buffer; mime: string }, categories: string[]) => Promise<ReadResult>;

const SYSTEM = `You read receipts for a small business owner's bookkeeping. Copy what the receipt says; never guess a number that isn't printed. Amounts are plain numbers without currency symbols. If a field isn't on the receipt, use null. Line items should follow the receipt's order; leave out lines that are only subtotals, tax or payment.`;

export class ReaderError extends Error {}

export function claudeReader(apiKey: () => string | null): ReceiptReader {
  return async (file, categories) => {
    const key = apiKey();
    if (!key) throw new ReaderError('Add an Anthropic API key in Settings to read receipts automatically, or fill in the details yourself.');
    const client = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 120_000 });
    const source = { type: 'base64' as const, data: file.data.toString('base64') };
    const block =
      file.mime === 'application/pdf'
        ? { type: 'document' as const, source: { ...source, media_type: 'application/pdf' as const } }
        : { type: 'image' as const, source: { ...source, media_type: file.mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' } };

    let response;
    try {
      response = await client.beta.messages.parse({
        model: READER_MODEL,
        max_tokens: 16000,
        // If the model declines, the request is retried on its default fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: betaZodOutputFormat(ReceiptSchema) },
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: [block, { type: 'text', text: `Read this receipt. Categories to choose from: ${categories.join('; ')}.` }],
          },
        ],
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new ReaderError('The Anthropic API key was refused. Check it in Settings.');
      if (err instanceof Anthropic.PermissionDeniedError) throw new ReaderError("The Anthropic API key isn't allowed to use this model.");
      if (err instanceof Anthropic.RateLimitError) throw new ReaderError('Anthropic is busy or the account has hit its limit. It will be tried again later.');
      if (err instanceof Anthropic.BadRequestError) throw new ReaderError(`Anthropic couldn't read this file: ${err.message}`);
      if (err instanceof Anthropic.APIError) throw new ReaderError(`Anthropic replied with an error (${err.status ?? 'no status'}). It will be tried again later.`);
      throw err;
    }
    if (response.stop_reason === 'refusal') throw new ReaderError('The receipt could not be read automatically. Fill in the details yourself.');
    if (response.stop_reason === 'max_tokens') throw new ReaderError('The receipt was too long to read in one go. Fill in the details yourself.');
    const reading = response.parsed_output;
    if (!reading) throw new ReaderError('The reply could not be understood. Try reading it again.');
    return {
      reading,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  };
}
