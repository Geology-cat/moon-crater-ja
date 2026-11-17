# 月面クレーター 日本語アノテーション

月の写真をドラッグ＆ドロップするだけで、クレーター・海・山脈・谷などの名前を**日本語で**写真に書き込む Web アプリです。

- 全体像・半月・三日月・望遠鏡での拡大写真に対応
- 拡大するほど小さなクレーターや副クレーター（コペルニクスA など）まで表示
- 地名にマウスを乗せる（スマホではタップ）と、ラテン名・種類・大きさ・月面座標を表示
- 注釈付き画像を JPEG / PNG で保存（画像全体／表示中の範囲）
- 大きな画像は読み込み時に自動で縮小（表示・保存用は長辺 4096px、解析用は長辺 2048px）

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

## ローカルで動かす

```bash
python3 -m http.server 8000
```

ブラウザで http://localhost:8000 を開きます（`file://` で直接開くと地名データを読み込めません）。

## クレジット

- 月面の位置合わせ：[SkySolver.app](https://skysolver.app/) Moon API（無料・キー不要・レート制限あり）
- 地名：[IAU / USGS Gazetteer of Planetary Nomenclature](https://planetarynames.wr.usgs.gov/)
- 日本語名：[Wikidata](https://www.wikidata.org/)、日本語版 Wikipedia、手作業による補完
- フォント：[Noto Sans JP](https://fonts.google.com/noto/specimen/Noto+Sans+JP)
