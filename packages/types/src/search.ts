export type SearchResultType = 'videos' | 'channels' | 'playlists';
export type SearchSort = 'relevance' | 'uploadDate' | 'views';

export interface SearchFilters {
  query?: string;
  sort?: SearchSort;
}
