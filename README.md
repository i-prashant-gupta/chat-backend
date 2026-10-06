# Chat Backend (Node + TypeScript + MySQL + Firestore)

## Setup
1. `npm install`
2. Copy `.env.example` to `.env` and set your MySQL password
3. Put Firebase service account JSON as `serviceAccountKey.json` in the root
4. Run `sql/schema.sql` in MySQL
5. `npm run dev`

## APIs
| Method | Route | Body |
|---|---|---|
| POST | /chats | { userAId, userBId } |
| POST | /chats/:chatId/messages/send | { senderId, text } |
| GET | /chats/:chatId/messages?limit=50 | - |
| POST | /chats/:chatId/messages/read | { userId } |
| POST | /chats/:chatId/last-seen | { userId } |
| GET | /users/:userId/chats | - |
