import { sendNotificationSlot } from './_shared/notifications.mjs';

export default async () => {
  await sendNotificationSlot(4);
};

export const config = { schedule: '30 12 * * *' };
