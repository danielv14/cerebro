// Every LIKE built from user input pairs this with an explicit ESCAPE '\' clause.
export const escapeLike = (fragment: string): string =>
  fragment.replace(/[\\%_]/g, (ch) => `\\${ch}`);
