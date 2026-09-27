const mockWindow = {
  minimize: () => {},
  toggleMaximize: () => {},
  isMaximized: () => Promise.resolve(false),
  close: () => {},
  show: () => {},
  setFocus: () => {},
  hide: () => {},
};

export const getCurrentWindow = () => mockWindow;
