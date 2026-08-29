import {
  MAX_CABINET_FILE_BYTES,
  fileRefFromMessage,
  kindFor,
  mirrorTelegramFile,
} from '../src/addons/lk/attachments';
import { notifyCabinet, notifyCabinetFile } from '../src/addons/lk/notify';
import TelegramAddon from '../src/addons/telegram';

jest.mock('../src/addons/lk/notify', () => ({
  notifyCabinet: jest.fn().mockResolvedValue(undefined),
  notifyCabinetFile: jest.fn().mockResolvedValue(true),
}));

const fetchFile = jest.fn();
jest.mock('../src/addons/telegram', () => ({
  __esModule: true,
  default: { getInstance: () => ({ fetchFile: (...args: any[]) => fetchFile(...args) }) },
}));

describe('LK attachments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fetchFile.mockResolvedValue(Buffer.from('screenshot-bytes'));
  });

  describe('kindFor', () => {
    it('sends real images as photos', () => {
      expect(kindFor('image/png', 'shot.png')).toBe('photo');
      expect(kindFor('image/jpeg', 'shot.jpg')).toBe('photo');
      expect(kindFor('', 'shot.JPEG')).toBe('photo');
    });

    it('sends everything else as a document', () => {
      // GIF would arrive as a muted animation and SVG is refused outright.
      expect(kindFor('image/gif', 'a.gif')).toBe('document');
      expect(kindFor('image/svg+xml', 'a.svg')).toBe('document');
      expect(kindFor('application/pdf', 'invoice.pdf')).toBe('document');
      expect(kindFor('text/plain', 'xray.log')).toBe('document');
    });
  });

  describe('fileRefFromMessage', () => {
    it('takes the largest rendered size of a photo', () => {
      const ref = fileRefFromMessage(
        {
          message_id: 7,
          photo: [
            { file_id: 'small', file_size: 100 },
            { file_id: 'original', file_size: 4000 },
          ],
        },
        'photo',
      );
      expect(ref).toMatchObject({ fileId: 'original', mime: 'image/jpeg', size: 4000 });
    });

    it('keeps the document name and type', () => {
      const ref = fileRefFromMessage(
        { message_id: 8, document: { file_id: 'doc', file_name: 'xray.log', mime_type: 'text/plain', file_size: 12 } },
        'document',
      );
      expect(ref).toMatchObject({ fileId: 'doc', name: 'xray.log', mime: 'text/plain' });
    });

    it('returns null when the message carries no file of that type', () => {
      expect(fileRefFromMessage({ message_id: 9 }, 'document')).toBeNull();
      expect(fileRefFromMessage(null, 'photo')).toBeNull();
    });
  });

  describe('mirrorTelegramFile', () => {
    const ref = { fileId: 'f1', name: 'shot.png', mime: 'image/png', size: 2048 };

    it('sends the file to the cabinet base64-encoded', async () => {
      const ok = await mirrorTelegramFile({
        ticketId: 12,
        shmUserId: 345,
        ref,
        caption: 'вот скриншот',
        direction: 'in',
        externalId: '12:tg:99',
      });

      expect(ok).toBe(true);
      expect(notifyCabinetFile).toHaveBeenCalledTimes(1);
      const payload = (notifyCabinetFile as jest.Mock).mock.calls[0][0];
      expect(payload).toMatchObject({
        ticket_id: 12,
        shm_user_id: 345,
        direction: 'in',
        text: 'вот скриншот',
        external_id: '12:tg:99',
      });
      expect(Buffer.from(payload.file.data_b64, 'base64').toString()).toBe('screenshot-bytes');
      expect(payload.file).toMatchObject({ name: 'shot.png', mime: 'image/png', tg_file_id: 'f1' });
    });

    it('announces a file too large to carry instead of downloading it', async () => {
      const ok = await mirrorTelegramFile({
        ticketId: 12,
        shmUserId: 345,
        ref: { ...ref, size: MAX_CABINET_FILE_BYTES + 1 },
        caption: '',
        direction: 'in',
        externalId: '12:tg:100',
      });

      expect(ok).toBe(false);
      expect(fetchFile).not.toHaveBeenCalled();
      expect(notifyCabinetFile).not.toHaveBeenCalled();
      expect((notifyCabinet as jest.Mock).mock.calls[0][0].text).toContain('слишком большой');
    });

    it('falls back to a text note when the download fails', async () => {
      fetchFile.mockRejectedValueOnce(new Error('410 gone'));

      const ok = await mirrorTelegramFile({
        ticketId: 12,
        shmUserId: 345,
        ref,
        caption: 'лог',
        direction: 'out',
        externalId: '12:staff:101',
      });

      expect(ok).toBe(false);
      expect(notifyCabinetFile).not.toHaveBeenCalled();
      expect((notifyCabinet as jest.Mock).mock.calls[0][0].text).toContain('не удалось перенести');
    });

    it('does nothing for a ticket with no cabinet customer', async () => {
      const ok = await mirrorTelegramFile({
        ticketId: 12,
        shmUserId: null,
        ref,
        caption: '',
        direction: 'in',
        externalId: '12:tg:102',
      });

      expect(ok).toBe(false);
      expect(notifyCabinet).not.toHaveBeenCalled();
      expect(notifyCabinetFile).not.toHaveBeenCalled();
    });
  });
});
