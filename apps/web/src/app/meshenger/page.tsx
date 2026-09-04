import { redirect } from 'next/navigation';

export default function LegacyMeshengerPage() {
  // Meshenger is not a product surface in Vidak. Preserve old links by
  // sending them directly to the canonical private video-space library.
  redirect('/');
}
