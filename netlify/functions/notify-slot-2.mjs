import { sendNotificationSlot } from './_shared/notifications.mjs';

export default async () => {
  await sendNotificationSlot(2);
};

export const config = { schedule: '30 6 * * *' };
