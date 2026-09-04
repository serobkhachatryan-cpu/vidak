import { redirect } from 'next/navigation';

export default function SubscriptionsPage() {
  // Following is not a persistent Vidak workflow yet. Do not strand people
  // in a placeholder; old links land in the usable public-video browser.
  redirect('/?tab=explore');
}
