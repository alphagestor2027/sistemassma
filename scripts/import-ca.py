"""Convert the CA CSV to one JSON object per certificate for a privileged bulk import."""
import argparse
import csv
import json
from pathlib import Path

HEADER = "NR Registro CA;DATA DE VALIDADE;SITUACAO;NR DO PROCESSO;CNPJ;RAZAO SOCIAL;NATUREZA;EQUIPAMENTO;DESCRICAO EQUIPAMENTO;MARCA CA;REFERENCIA;COR;APROVADO PARA LAUDO;RESTRICAO LAUDO;OBSERVACAO ANALISE LAUDO;CNPJ LABORATORIO;RAZAO SOCIAL LABORATORIO;NR LAUDO;NORMA".split(";")
FIELDS = "validade situacao processo cnpj fabricante natureza equipamento descricao marcacao referencia cor aprovado restricao observacao".split()
REPORT = "cnpj laboratorio laudo norma".split()

def certificates(path):
    catalog = {}
    with path.open(encoding="utf-8-sig", newline="") as stream:
        rows = csv.reader(stream, delimiter=";", strict=True)
        header = next(rows)
        header[0] = header[0].lstrip("\ufeff")
        if header != HEADER:
            raise ValueError("Cabeçalho de CA desconhecido")
        for row in rows:
            if len(row) != len(HEADER) or not row[0].isascii() or not row[0].isdigit():
                raise ValueError(f"Registro inválido na linha {rows.line_num}")
            ca = str(int(row[0]))
            fields = tuple(value.strip() for value in row[1:15])
            reports = catalog.setdefault(ca, {}).setdefault(fields, {})
            report = tuple(value.strip() for value in row[15:])
            if any(report):
                reports[report] = None
    for ca, versions in catalog.items():
        result = []
        for fields, reports in versions.items():
            record = dict(zip(FIELDS, fields))
            record["laudos"] = [dict(zip(REPORT, report)) for report in reports]
            result.append(record)
        yield {"ca": ca, "fichas": result}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", type=Path)
    parser.add_argument("jsonl", type=Path)
    args = parser.parse_args()
    with args.jsonl.open("w", encoding="utf-8", newline="\n") as out:
        for certificate in certificates(args.csv):
            out.write(json.dumps(certificate, ensure_ascii=False, separators=(",", ":")) + "\n")
