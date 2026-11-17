# 月面クレーター 日本語アノテーション

月の写真をドラッグ＆ドロップするだけで、クレーター・海・山脈・谷などの名前を**日本語で**写真に書き込む Web アプリです。

- 全体像・半月・三日月・望遠鏡での拡大写真に対応
- 拡大するほど小さなクレーターや副クレーター（コペルニクスA など）まで表示
- 地名にマウスを乗せる（スマホではタップ）と、ラテン名・種類・大きさ・月面座標を表示
- 月の海の輪郭（LROC の境界データ）を表示。海の名前に乗せるとその海の範囲を強調。拡大すると細かい輪郭に切り替わります
- JPEG / PNG / WebP のほか、TIFF・HEIC/HEIF もブラウザ内で変換して読み込み（ライブラリは必要なときだけ読み込み）
- 注釈付き画像を JPEG / PNG で保存（画像全体／表示中の範囲。どちらも元の解像度）
- **共有用HTMLファイル**を作成：拡大・地名表示・海の輪郭・ポップアップがそのまま使える1ファイルを作ります。受け取った人はブラウザで開くだけで見られ（再解析しないので SkySolver への接続は不要）、ウェブサーバーに置けばリンクで共有できます。スマホでは共有メニューから直接送れます
- 表示・保存は元の解像度のまま。解析用にだけ長辺 2048px に縮小して送信（表示用は Chrome 等で約 8000 万画素、Safari で約 1600 万画素を超える場合のみ縮小）

## 使い方

1. ページを開き、月の写真をドロップ（または「画像を選ぶ」）
2. 数秒で解析が終わり、地名が表示されます
3. ホイール／ピンチで拡大、ドラッグで移動。右側のパネルで詳細度や表示項目を変更
4. 「画像全体を保存」または「表示中の範囲を保存」でダウンロード

## しくみ

1. 画像をブラウザ内で縮小し、[SkySolver](https://skysolver.app/moon) の Moon API（`POST /api/v1/solve/moon`）に送信します。
   月の円盤の中心・半径・北の向き・鏡像・秤動（`view`）と、太陽の方向・月相が返ってきます。
2. API ドキュメントの投影式で、IAU 地名（月の表側 6,971 件）の月面座標を写真の画素座標に変換して描画します。
3. 画面上での大きさが一定以上になった地形だけを表示し、ラベル同士が重ならないように配置します。そのため拡大するほど細かい地名が現れます。

すべてブラウザ内で動く静的サイトで、サーバーは不要です。解析のため縮小した画像が SkySolver に送信されます（SkySolver は画像を保存・記録しないと説明しています）。

## 日本語名について

`data/features.json` は `tools/build_features.py` で生成しています。日本語名は次の優先順位で決めています。

1. `tools/names_manual.json`（手作業の補完と表記の統一。例：Rupes Recta →「直線の壁」）
2. Wikidata の日本語ラベル（USGS 地名 ID で照合）
3. 日本語版 Wikipedia の「月のクレーターの一覧」「月の海の一覧」
4. 種類を表す語の置き換え（Rima → 谷、Dorsa → 尾根群、Mons → 山、Montes → 山脈、Promontorium → 岬 など）
5. 副クレーターは「親クレーター名＋記号」（例：Copernicus A → コペルニクスA）

データを作り直すには次を実行します。

```bash
curl -LO https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip
unzip MOON_nomenclature_center_pts.zip
python3 tools/build_features.py MOON_nomenclature_center_pts.dbf
```

## 対応ブラウザ

最新の Chrome / Edge / Firefox / Safari のほか、古いブラウザ（Chrome 103、Safari 12 程度）でも動くように書いています。

- JavaScript は ES2018 までの構文のみ（`?.` や `??` は不使用）
- Pointer Events・ResizeObserver・createImageBitmap がない環境では、マウス／タッチイベント・resize イベント・`<img>` で代替
- EXIF の向きを自動で反映しないブラウザでは、JPEG の EXIF を読んで回転
- Blob.arrayBuffer がないブラウザ向けの補完あり

注意：SkySolver（skysolver.app）の証明書は Let's Encrypt の ISRG Root X2 系のチェーンです。この証明書を信頼していない古い OS（iOS 12 / macOS 10.14 世代など）では、アプリは表示されても解析サーバーに接続できない場合があります。OS を更新するか、端末に [ISRG Root X2](https://letsencrypt.org/certificates/) を追加してください。

実機の古いブラウザでは試験していません。新しいブラウザで古い API を無効にした模擬環境で動作を確認しています。

## 海の輪郭データ

`data/mare.json` は `tools/build_mare.py` で、LROC Global Mare Boundaries（Nelson et al. 2014）から作っています。全体表示用（誤差約 0.12°）と拡大用（約 0.025°）の 2 段階に簡略化しています。

```bash
curl -LO https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/EXTRAS/SHAPEFILE/LROC_GLOBAL_MARE/LROC_GLOBAL_MARE_180.ZIP
unzip LROC_GLOBAL_MARE_180.ZIP
python3 tools/build_mare.py LROC_GLOBAL_MARE_180.SHP
```

## ローカルで動かす

```bash
python3 -m http.server 8000
```

ブラウザで http://localhost:8000 を開きます（`file://` で直接開くと地名データを読み込めません）。

## クレジット

- 月面の位置合わせ：[SkySolver.app](https://skysolver.app/) Moon API（無料・キー不要・レート制限あり）
- 地名：[IAU / USGS Gazetteer of Planetary Nomenclature](https://planetarynames.wr.usgs.gov/)
- 日本語名：[Wikidata](https://www.wikidata.org/)、日本語版 Wikipedia、手作業による補完
- 海の輪郭：[LROC Global Mare Boundaries](https://data.lroc.im-ldi.com/lroc/view_rdr/SHAPEFILE_LROC_GLOBAL_MARE)（Nelson, D. M. et al. 2014, LPSC 45, 2861）
- フォント：[Noto Sans JP](https://fonts.google.com/noto/specimen/Noto+Sans+JP)
- 画像変換ライブラリ（`lib/`、各ライセンスファイル同梱）：[UTIF.js](https://github.com/photopea/UTIF.js)（MIT）、[pako](https://github.com/nodeca/pako)（MIT）、[heic-to](https://github.com/hoppergee/heic-to)（LGPL-3.0）、[heic2any](https://github.com/alexcorvi/heic2any)（MIT）
