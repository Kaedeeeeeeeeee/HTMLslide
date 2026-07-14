export type PresenterSlideSearchEntry = {
  id: string;
  slideNumber: number;
  title: string;
};

export function filterPresenterSlideIndices(
  slides: readonly PresenterSlideSearchEntry[],
  query: string
): number[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length === 0) {
    return slides.map((_, index) => index);
  }

  return slides.flatMap((slide, index) => {
    const searchableText = `${slide.slideNumber} ${slide.id} ${slide.title}`.toLocaleLowerCase();
    return searchableText.includes(normalizedQuery) ? [index] : [];
  });
}
