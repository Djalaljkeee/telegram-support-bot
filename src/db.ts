import mongoose from 'mongoose';
import cache from './cache';
import { Messenger } from './interfaces';
import * as log from 'fancy-log'

const MONGO_URI = cache.config.mongodb_uri || process.env.MONGO_URI || 'mongodb://localhost:27017/support';
const botTokenSuffix = cache.config.bot_token.slice(-5);
const collectionName = `bot_${cache.config.owner_id}_${botTokenSuffix}`;

export interface ISupportee extends mongoose.Document {
  ticketId: number;
  userid: string;
  internalIds: Array<number> | null;
  name: string | null;
  messenger: Messenger;
  status: string;
  category: string | null;
  /** Forum topic (message_thread_id) opened for this ticket in the staff chat. */
  threadId: number | null;
  /** SHM user id, set once the customer writes from the personal cabinet. */
  shmUserId: number | null;
  /** Whether this ticket's forum topic is currently closed in Telegram. */
  topicClosed: boolean;
}

export const SupporteeSchema = new mongoose.Schema<ISupportee>({
  ticketId: { type: Number, required: true, unique: true, alias: 'id' },
  userid: { type: String, required: true },
  internalIds: { type: [Number], required: false },
  name: { type: String, required: false },
  messenger: { type: String, required: true },
  status: { type: String, default: 'open' },
  category: { type: String, default: null },
  threadId: { type: Number, required: false, default: null },
  shmUserId: { type: Number, required: false, default: null },
  topicClosed: { type: Boolean, required: false, default: false },
});

const Supportee = mongoose.model(collectionName, SupporteeSchema);

export async function connect() {
  mongoose.connection.on('open', () => {
    log.info('Connected to mongo server.');
  });

  mongoose.connection.on('error', (err) => {
    log.info('Could not connect to mongo server!', err);
    process.exit(1);
  });

  const connection = await mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
  });

  return connection;
}

/** Methods **/

export const getNextTicketId = async () => {
  const lastEntry = await Supportee.findOne()
    .sort({ ticketId: -1 })
    .select('ticketId');
  return lastEntry ? lastEntry.ticketId + 1 : 1; // Start from 1 if no entries
};

export const check = async (
  userid: any,
  category: any,
  callback: (result: any) => void
) => {
  const query = {
    $or: [{ userid: userid }, { ticketId: userid }],
    ...(category && { category }),
  };
  const result = await Supportee.find(query);
  callback(result);
};

export async function getTicketById(
  ticketId: string | number,
  category: string | null
): Promise<ISupportee | null> {
  const query = {
    $or: [{ ticketId: ticketId }],
    ...(category ? { category } : { category: null }),
  };
  const result = await Supportee.findOne(query);
  return result as ISupportee | null;
};

export async function getTicketByInternalId (
  internalId: number
): Promise<ISupportee | null> {
  const query = {
    internalIds: { $elemMatch: { $eq: internalId } },
  };
  const result = await Supportee.findOne(query);
  return result as ISupportee | null;
}

export async function getTicketByUserId (
  userId: string | number,
  category: string | null
) {
  const query = {
    $or: [{ userid: userId }],
    ...(category ? { category } : { category: null }),
  };
  const result = await Supportee.findOne(query);
  return result;
};

/**
 * Stores the forum topic opened for a ticket in the staff chat.
 *
 * @param ticketId - Ticket the topic belongs to.
 * @param threadId - Telegram message_thread_id of the topic.
 */
export async function setThreadId(ticketId: number, threadId: number) {
  return await Supportee.findOneAndUpdate(
    { ticketId },
    { $set: { threadId } },
    { new: true },
  );
}

/**
 * Tracks whether the ticket's forum topic is closed.
 *
 * Kept separately from the ticket status: the status returns to 'open' as soon
 * as the customer writes again, which happens before we get a chance to look at
 * the topic, so it cannot tell us whether the topic still needs reopening.
 *
 * @param ticketId - Ticket the topic belongs to.
 * @param closed - New topic state.
 */
export async function setTopicClosed(ticketId: number, closed: boolean) {
  return await Supportee.findOneAndUpdate(
    { ticketId },
    { $set: { topicClosed: closed } },
    { new: true },
  );
}

/**
 * Links a ticket to its SHM customer. From then on the ticket's messages are
 * mirrored into the personal cabinet, including the ones written in Telegram.
 *
 * @param ticketId - Ticket to link.
 * @param shmUserId - SHM user id.
 */
export async function setShmUserId(ticketId: number, shmUserId: number) {
  return await Supportee.findOneAndUpdate(
    { ticketId },
    { $set: { shmUserId } },
    { new: true },
  );
}

/**
 * Looks a ticket up by the forum topic it lives in, so staff can just write in
 * the topic instead of replying to a specific message.
 *
 * @param threadId - Telegram message_thread_id of the topic.
 */
export async function getTicketByThreadId(
  threadId: number,
): Promise<ISupportee | null> {
  const result = await Supportee.findOne({ threadId });
  return result as ISupportee | null;
}

export const getByTicketId = async (
  ticketId: string,
  callback: (ticket: any) => void
) => {
  const query = { $or: [{ ticketId: ticketId }] };
  const result = await Supportee.findOne(query);
  callback(result);
};

export const checkBan = async (
  userid: any,
  messenger: string,
  callback: (ticket: any) => void
) => {
  const query = {
    messenger,
    $or: [{ userid: userid }],
    status: 'banned',
  };
  const result = await Supportee.findOne(query);
  callback(result);
};

export const closeAll = async () => {
  await Supportee.updateMany({}, { $set: { status: 'closed' } });
};

export const reopen = async (userid: any, category: string, messenger: string) => {
  const query = {
    messenger,
    $or: [{ userid: userid }, { ticketId: userid }],
    ...(category && { category }),
  };
  await Supportee.updateMany(query, { $set: { status: 'open' } });
};

export const addIdAndName = async (
  ticketId: string | number,
  internalId: string,
  name: string | null,
) => {
  if (!internalId) {
    return null;
  }
  const internalIdNum = parseInt(internalId);
  const query = {
    ticketId: ticketId,
  };
  const update = {
    $addToSet: { internalIds: internalIdNum },
    $set: { name },
  };
  return await Supportee.findOneAndUpdate(query, update, {
    new: true,
    upsert: true,
  });
};

export const add = async (
  userid: string | number,
  status: string,
  category: string | number | null,
  messenger: string
) => {
  let result;
  if (status === 'closed') {
    const query = {
      messenger,
      $or: [{ userid: userid }, { ticketId: userid }],
      ...(category && { category }),
    };
    result = await Supportee.updateMany(query, { $set: { status: 'closed' } });
  } else if (status === 'open') {
    const ticketId = await getNextTicketId();
    // Update, never replace: a replace wipes threadId, internalIds and name and
    // hands out a fresh ticketId. That path is reached for any *existing* closed
    // ticket (files.ts reopens one this way, and auto_close_tickets closes every
    // ticket after an answer), so replacing loses the customer's forum topic
    // mid-conversation.
    result = await Supportee.findOneAndUpdate(
      { messenger, userid },
      {
        $set: { status, category },
        $setOnInsert: { userid, messenger, ticketId },
      },
      { upsert: true, new: true }
    );
  } else if (status === 'banned') {
    result = await Supportee.findOneAndReplace(
      { messenger, userid },
      {
        userid,
        messenger,
        ticketId: await getNextTicketId(),
        status: 'banned',
        category: 'BANNED',
      },
      { upsert: true }
    );
  }
  return result?.modifiedCount || 0;
};

export const open = async (
  callback: Function,
  category: string[],
) => {
  const query = {
    status: 'open',
    ...(category.length > 0
      ? { category: { $in: category } }
      : { category: null }),
  };
  const result = await Supportee.find(query);
  callback(result);
};
