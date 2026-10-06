CREATE DATABASE IF NOT EXISTS chat_app;
USE chat_app;

CREATE TABLE users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE chats (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  direct_key VARCHAR(50) NOT NULL UNIQUE,
  last_message_at DATETIME(3) NULL,
  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE chat_members (
  chat_id INT UNSIGNED,
  user_id INT UNSIGNED,
  last_seen_at DATETIME(3) NULL,
  PRIMARY KEY (chat_id, user_id),
  INDEX (user_id),
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO users (name) VALUES ('Alice'), ('Bob'), ('Charlie');
