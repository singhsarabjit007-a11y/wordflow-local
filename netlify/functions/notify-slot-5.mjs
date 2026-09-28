import { sendNotificationSlot } from './_shared/notifications.mjs';

export default async () => {
  await sendNotificationSlot(5);
};

export const config = { schedule: '30 15 * * *' };
