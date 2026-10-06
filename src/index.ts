import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import mysql, { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import admin, { ServiceAccount } from 'firebase-admin';
import { readFileSync } from 'fs';
import { join } from 'path';

// ---------- Setup ----------
const db = mysql.createPool({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME, timezone: 'Z',
});
const serviceAccount = JSON.parse(
  readFileSync(join(__dirname, '..', 'serviceAccountKey.json'), 'utf8'),
) as ServiceAccount;
admin.initializeApp({ credential: admin.credential.cert(serviceAccount),
  projectId :serviceAccount.projectId,
 });

  const fs = admin.firestore();
const msgs = (chatId: number) => fs.collection('chats').doc(String(chatId)).collection('messages');

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const toId = (v: unknown, name: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} must be a positive integer`);
  return n;
};
const assertMember = async (chatId: number, userId: number) => {
  const [rows] = await db.execute<RowDataPacket[]>(
    'SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
  if (!rows.length) throw new HttpError(403, 'User is not a member of this chat');
};

const app = express();
app.use(express.json());

// ---------- 1. Create or get 1:1 chat ----------
app.post('/chats', wrap(async (req, res) => {
  const a = toId(req.body.userAId, 'userAId'), b = toId(req.body.userBId, 'userBId');
  if (a === b) throw new HttpError(400, 'Users must be different');
  const key = `${Math.min(a, b)}_${Math.max(a, b)}`; // same key for (1,2) and (2,1)

  const [found] = await db.execute<RowDataPacket[]>('SELECT id FROM chats WHERE direct_key = ?', [key]);
  if (found.length) return res.json({ chatId: found[0].id, created: false });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.execute<ResultSetHeader>('INSERT INTO chats (direct_key) VALUES (?)', [key]);
    await conn.query('INSERT INTO chat_members (chat_id, user_id) VALUES ?', [[[r.insertId, a], [r.insertId, b]]]);
    await conn.commit();
    res.status(201).json({ chatId: r.insertId, created: true });
  } catch (e: any) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') { // concurrent request already created it
      const [again] = await db.execute<RowDataPacket[]>('SELECT id FROM chats WHERE direct_key = ?', [key]);
      if (again.length) return res.json({ chatId: again[0].id, created: false });
    }
    if (e.code === 'ER_NO_REFERENCED_ROW_2') throw new HttpError(404, 'User not found');
    throw e;
  } finally { conn.release(); }
}));

// ---------- 2. Send message (Firestore) ----------
app.post('/chats/:chatId/messages/send', wrap(async (req, res) => {
  const chatId = toId(req.params.chatId, 'chatId'), senderId = toId(req.body.senderId, 'senderId');
  const text = String(req.body.text ?? '').trim();
  if (!text) throw new HttpError(400, 'text is required');
  await assertMember(chatId, senderId);

  const ref = await msgs(chatId).add({
    senderId, text, readBy: {},
    createdAt: admin.firestore.FieldValue.serverTimestamp(), // server time -> correct ordering
  });
  await db.execute('UPDATE chats SET last_message_at = NOW(3) WHERE id = ?', [chatId]);
  res.status(201).json({ id: ref.id, chatId, senderId, text });
}));

// ---------- 3. Get messages (ordered by timestamp) ----------
app.get('/chats/:chatId/messages', wrap(async (req, res) => {
  const chatId = toId(req.params.chatId, 'chatId');
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const snap = await msgs(chatId).orderBy('createdAt', 'desc').limit(limit).get();
  const list = snap.docs.map((d) => {
    const m = d.data();
    return { id: d.id, ...m, createdAt: m.createdAt?.toDate().toISOString() };
  });
  res.json(list.reverse()); // oldest -> newest
}));

// ---------- 4. Mark messages read (Firestore read receipts) ----------
app.post('/chats/:chatId/messages/read', wrap(async (req, res) => {
  const chatId = toId(req.params.chatId, 'chatId'), userId = toId(req.body.userId, 'userId');
  await assertMember(chatId, userId);

  const snap = await msgs(chatId).orderBy('createdAt', 'desc').limit(500).get();
  const unread = snap.docs.filter((d) => d.data().senderId !== userId && !d.data().readBy?.[userId]);
  const batch = fs.batch();
  const field = new admin.firestore.FieldPath('readBy', String(userId));
  unread.forEach((d) => batch.update(d.ref, field, admin.firestore.Timestamp.now()));
  if (unread.length) await batch.commit();
  res.json({ markedRead: unread.length });
}));

// ---------- 5. Update last seen ----------
app.post('/chats/:chatId/last-seen', wrap(async (req, res) => {
  const chatId = toId(req.params.chatId, 'chatId'), userId = toId(req.body.userId, 'userId');
  await assertMember(chatId, userId);
  await db.execute('UPDATE chat_members SET last_seen_at = NOW(3) WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
  res.json({ chatId, userId, lastSeenAt: new Date().toISOString() });
}));

// ---------- 6. User's chats with member IDs ----------
app.get('/users/:userId/chats', wrap(async (req, res) => {
  const userId = toId(req.params.userId, 'userId');
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT c.id AS chatId, c.last_message_at AS lastMessageAt,
            (SELECT JSON_ARRAYAGG(m.user_id) FROM chat_members m WHERE m.chat_id = c.id) AS memberIds
     FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
     WHERE cm.user_id = ?
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`, [userId]);
  res.json(rows);
}));

// ---------- Error handler ----------
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(process.env.PORT || 3000, () => console.log('Server running on port', process.env.PORT || 3000));
