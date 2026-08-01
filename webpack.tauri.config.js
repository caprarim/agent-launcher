const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

// Renderer build for the Linux (Tauri v2) shell. Same React source as the
// Electron renderer, different entry point and host target:
//   - target 'web', not 'electron-renderer' (no node integration to lean on)
//   - ESM output so @tauri-apps/api resolves through its exports map and the
//     dynamic import in index.tauri.tsx becomes a real chunk
//   - relative publicPath so those chunks load under the tauri asset protocol
module.exports = {
  mode: 'production',
  entry: './src/renderer/index.tauri.tsx',
  target: 'web',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: 'ts-loader',
          options: {
            compilerOptions: {
              module: 'esnext',
              moduleResolution: 'bundler',
            },
          },
        },
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  output: {
    path: path.resolve(__dirname, 'dist-tauri'),
    filename: 'renderer.js',
    chunkFilename: '[name].[contenthash].js',
    publicPath: '',
    clean: true,
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/renderer/index.tauri.html',
      filename: 'index.html',
    }),
  ],
};
