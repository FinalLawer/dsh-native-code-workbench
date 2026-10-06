def fibonacci(n):
    """返回前 n 个斐波那契数（n <= 0 时返回空列表）。"""
    if n <= 0:
        return []
    seq = [0, 1]
    while len(seq) < n:
        seq.append(seq[-1] + seq[-2])
    return seq[:n]


if __name__ == "__main__":
    num = int(input("请输入项数: "))
    print(fibonacci(num))
