import { SearchPage } from '../../features/search/search-page';

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return <SearchPage initialQuery={q ?? ''} />;
}
