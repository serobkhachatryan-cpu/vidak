import { redirect } from 'next/navigation';

export default function YourVideosPage() {
  // Keep old bookmarks useful without maintaining a second library route that
  // lacks an active navigation item. The canonical signed-in library is /.
  redirect('/?tab=yours');
}
