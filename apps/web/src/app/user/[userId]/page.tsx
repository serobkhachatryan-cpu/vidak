import { UserProfilePageFeature } from '../../../features/user/user-profile-page';

export default async function Page({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  return <UserProfilePageFeature userId={userId} />;
}
