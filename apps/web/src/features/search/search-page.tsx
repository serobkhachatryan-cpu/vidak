'use client';

import {
  useChannel,
  useInfiniteChannels,
  useInfinitePlaylists,
  useInfiniteVideos,
} from '@w3ds/hooks';
import type { SearchResultType, SearchSort, Video } from '@w3ds/types';
import {
  ChannelSearchResult,
  EmptyState,
  ErrorState,
  Grid,
  Page,
  PlaylistSearchResult,
  SearchFilters,
  SearchInput,
  SearchResultSkeleton,
  SearchSortControl,
  Spinner,
  VideoCard,
} from '@w3ds/ui';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ApplicationShell } from '../../components/application-shell';
import { videoApiClient } from '../../lib/video-api-client';

const RECENT_SEARCHES_KEY = 'w3ds-recent-searches';
const MAX_RECENT_SEARCHES = 6;

function SearchVideoCard({ video }: { video: Video }) {
  const { data: channel } = useChannel(videoApiClient, video.channelId);
  return <VideoCard video={video} {...(channel ? { channel } : {})} />;
}

function useRecentSearches() {
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  useEffect(() => {
    try {
      setRecentSearches(JSON.parse(window.localStorage.getItem(RECENT_SEARCHES_KEY) ?? '[]'));
    } catch {
      window.localStorage.removeItem(RECENT_SEARCHES_KEY);
    }
  }, []);

  const addRecentSearch = (query: string) => {
    const next = [
      query,
      ...recentSearches.filter((item) => item.toLocaleLowerCase() !== query.toLocaleLowerCase()),
    ].slice(0, MAX_RECENT_SEARCHES);
    setRecentSearches(next);
    window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
  };

  return { addRecentSearch, recentSearches };
}

export function SearchPage({ initialQuery = '' }: { initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [inputValue, setInputValue] = useState(initialQuery);
  const [type, setType] = useState<SearchResultType>('videos');
  const [sort, setSort] = useState<SearchSort>('relevance');
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const { addRecentSearch, recentSearches } = useRecentSearches();

  const videoSearch = useInfiniteVideos(
    videoApiClient,
    { search: query, sort, status: 'published', visibility: 'public' },
    12,
  );
  const channelSearch = useInfiniteChannels(videoApiClient, { query, sort }, 12);
  const playlistSearch = useInfinitePlaylists(videoApiClient, { query, sort }, 12);

  const suggestions = useMemo(() => {
    const normalized = inputValue.trim().toLocaleLowerCase();
    const matches = recentSearches.filter((item) => item.toLocaleLowerCase().includes(normalized));
    return normalized && !matches.some((item) => item.toLocaleLowerCase() === normalized)
      ? [`Search for “${inputValue.trim()}”`, ...matches]
      : matches;
  }, [inputValue, recentSearches]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !query) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        if (type === 'videos' && videoSearch.hasNextPage && !videoSearch.isFetchingNextPage) {
          void videoSearch.fetchNextPage();
        }
        if (type === 'channels' && channelSearch.hasNextPage && !channelSearch.isFetchingNextPage) {
          void channelSearch.fetchNextPage();
        }
        if (
          type === 'playlists' &&
          playlistSearch.hasNextPage &&
          !playlistSearch.isFetchingNextPage
        ) {
          void playlistSearch.fetchNextPage();
        }
      },
      { rootMargin: '240px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [
    channelSearch.fetchNextPage,
    channelSearch.hasNextPage,
    channelSearch.isFetchingNextPage,
    playlistSearch.fetchNextPage,
    playlistSearch.hasNextPage,
    playlistSearch.isFetchingNextPage,
    query,
    type,
    videoSearch.fetchNextPage,
    videoSearch.hasNextPage,
    videoSearch.isFetchingNextPage,
  ]);

  const submit = (event?: FormEvent<HTMLFormElement>, value = inputValue) => {
    event?.preventDefault();
    const nextQuery = value.trim();
    if (!nextQuery) return;
    setQuery(nextQuery);
    setInputValue(nextQuery);
    addRecentSearch(nextQuery);
    setActiveSuggestion(-1);
    window.history.replaceState(null, '', `/search?q=${encodeURIComponent(nextQuery)}`);
  };

  const selectSuggestion = (suggestion: string) => {
    const nextQuery = suggestion.startsWith('Search for “') ? inputValue.trim() : suggestion;
    submit(undefined, nextQuery);
  };

  const videos = videoSearch.data?.pages.flatMap((page) => page.items) ?? [];
  const channels = channelSearch.data?.pages.flatMap((page) => page.items) ?? [];
  const playlists = playlistSearch.data?.pages.flatMap((page) => page.items) ?? [];
  const currentSearch =
    type === 'videos' ? videoSearch : type === 'channels' ? channelSearch : playlistSearch;
  const resultCount =
    type === 'videos' ? videos.length : type === 'channels' ? channels.length : playlists.length;
  const isLoadingMore = currentSearch.isFetchingNextPage;

  return (
    <ApplicationShell currentHref="/search" searchValue={query}>
      <Page title="Search" description="Find videos, channels, and playlists.">
        <form onSubmit={submit} className="relative max-w-2xl">
          <SearchInput
            ref={inputRef}
            value={inputValue}
            onChange={(event) => {
              setInputValue(event.target.value);
              setActiveSuggestion(-1);
            }}
            onClear={() => {
              setInputValue('');
              setQuery('');
              window.history.replaceState(null, '', '/search');
              inputRef.current?.focus();
            }}
            onKeyDown={(event) => {
              if (!suggestions.length) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveSuggestion((current) =>
                  event.key === 'ArrowDown'
                    ? (current + 1) % suggestions.length
                    : (current + suggestions.length - 1) % suggestions.length,
                );
              }
              if (event.key === 'Escape') setActiveSuggestion(-1);
              if (event.key === 'Enter' && activeSuggestion >= 0) {
                event.preventDefault();
                selectSuggestion(suggestions[activeSuggestion] ?? '');
              }
            }}
            placeholder="Search videos, channels, and playlists"
            aria-autocomplete="list"
            aria-controls="search-suggestions"
            aria-activedescendant={
              activeSuggestion >= 0 ? `suggestion-${activeSuggestion}` : undefined
            }
          />
          {suggestions.length > 0 && inputValue && (
            <div
              id="search-suggestions"
              role="listbox"
              aria-label="Search suggestions"
              className="absolute z-10 mt-2 w-full overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-lg"
            >
              {suggestions.map((suggestion, index) => (
                <div
                  key={suggestion}
                  id={`suggestion-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === activeSuggestion}
                >
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectSuggestion(suggestion)}
                    className={`w-full rounded px-3 py-2 text-left font-sans text-sm ${
                      index === activeSuggestion
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {suggestion}
                  </button>
                </div>
              ))}
            </div>
          )}
        </form>

        {!query ? (
          <EmptyState
            icon="⌕"
            title="Search the community"
            description="Use the search box or choose a recent search to continue."
          />
        ) : (
          <div className="mt-8 space-y-6">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <SearchFilters value={type} onChange={setType} />
              <SearchSortControl value={sort} onChange={setSort} />
            </div>
            <p className="font-sans text-sm text-muted-foreground" aria-live="polite">
              {currentSearch.isPending
                ? 'Searching…'
                : `${resultCount} ${type} found for “${query}”`}
            </p>
            {currentSearch.isPending ? (
              <Grid columns={type === 'videos' ? 3 : 1} gap={6} aria-label="Loading search results">
                {Array.from({ length: type === 'videos' ? 9 : 4 }, (_, index) => (
                  <SearchResultSkeleton key={index} type={type} />
                ))}
              </Grid>
            ) : currentSearch.error ? (
              <ErrorState
                title="Could not search right now"
                description="Please check your connection and try again."
                retry={() => void currentSearch.refetch()}
              />
            ) : resultCount === 0 ? (
              <EmptyState
                icon="⌕"
                title="No results found"
                description="Try a different search term or switch the result type."
              />
            ) : (
              <>
                {type === 'videos' && (
                  <Grid columns={3} gap={6}>
                    {videos.map((video) => (
                      <SearchVideoCard key={video.id} video={video} />
                    ))}
                  </Grid>
                )}
                {type === 'channels' && (
                  <div className="space-y-4">
                    {channels.map((channel) => (
                      <ChannelSearchResult key={channel.id} channel={channel} />
                    ))}
                  </div>
                )}
                {type === 'playlists' && (
                  <div className="space-y-4">
                    {playlists.map((playlist) => (
                      <PlaylistSearchResult key={playlist.id} playlist={playlist} />
                    ))}
                  </div>
                )}
                <div
                  ref={loadMoreRef}
                  className="flex min-h-20 items-center justify-center"
                  aria-live="polite"
                >
                  {isLoadingMore && (
                    <span className="flex items-center gap-2 font-sans text-sm text-muted-foreground">
                      <Spinner size="sm" aria-hidden="true" />
                      Loading more results
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </Page>
    </ApplicationShell>
  );
}
